const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { classifyIntent, evaluateRisk, handleCommandWithAi } = require("../services/agent-runtime/src/agents/ceo-agent");
const { classifyExecutionRequest, createChatAgent, removeRoutingNarration } = require("../services/agent-runtime/src/agents/chat-agent");
const codingAgent = require("../services/agent-runtime/src/agents/coding-agent");
const { TASK_STATUSES, createAgentOrchestrator } = require("../services/agent-runtime/src/agents/orchestrator");
const { getRuntimeConfig, normalizeRuntimeMode } = require("../services/agent-runtime/src/config/runtime");
const { evaluateCommandPermission } = require("../services/agent-runtime/src/permissions/policy");
const { agentRegistry } = require("../services/agent-runtime/src/agents/registry");
const { createDatabaseRepository, migrateSqlite, PostgresRepository } = require("../packages/db/client");
const { GroqProvider, OllamaProvider, createLlmProvider, parseIntentFromText } = require("../services/agent-runtime/src/llm/provider");
const { createApprovalQueue } = require("../services/agent-runtime/src/approvals/queue");
const { createStorageService } = require("../services/file-service/src/storage");
const { createToolRegistry } = require("../services/agent-runtime/src/tools/tool-registry");
const { resolveWorkspacePath } = require("../services/agent-runtime/src/workspace/execution-workspace");
const { createWorkflowEngine } = require("../services/agent-runtime/src/workflows/workflow-engine");
const {
  createSessionToken,
  hashPassword,
  hashSessionToken,
  safeUser,
  verifyPassword
} = require("../services/api/src/auth");
const {
  createStorageProvider,
  LocalStorageProvider,
  S3StorageProvider,
  SupabaseStorageProvider
} = require("../services/file-service/src/providers");
const { rolePermissions, seedRbac } = require("../services/api/src/rbac");

function testAgentRegistry() {
  const requiredTypes = ["ceo", "coding", "testing", "content", "trading", "chat"];
  for (const type of requiredTypes) {
    assert.ok(agentRegistry.some((agent) => agent.type === type), `Missing ${type} agent`);
  }
}

function testCommandRouting() {
  assert.equal(classifyIntent("implement a new api route").agent.type, "coding");
  assert.equal(classifyIntent("run regression tests").agent.type, "testing");
  assert.equal(classifyIntent("draft a launch post").agent.type, "content");
  assert.equal(classifyIntent("analyze BTC risk").agent.type, "trading");
  assert.equal(classifyIntent("what should I do next?").agent.type, "chat");
}

function testRiskPolicy() {
  const tradingAgent = agentRegistry.find((agent) => agent.type === "trading");
  const codingAgent = agentRegistry.find((agent) => agent.type === "coding");

  assert.equal(evaluateRisk("buy now with real money", tradingAgent).approvalRequired, true);
  assert.equal(evaluateRisk("rm -rf storage", codingAgent).approvalType, "destructive_shell_command");
  assert.equal(evaluateRisk("explain this project", codingAgent).approvalRequired, false);

  const destructive = evaluateCommandPermission("rm -rf ./storage");
  assert.equal(destructive.decision, "require_approval");
}

async function testCeoCreatesCodingBuildTask() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId)
  });
  const orchestrator = createAgentOrchestrator({
    repository,
    approvalQueue,
    chatAgent,
    workspaceRoot: process.cwd()
  });
  const result = await handleCommandWithAi({
    command: "create simple calculator",
    createTask: (payload) => repository.createTask(payload),
    approvalQueue,
    orchestrator,
    llmProvider: {
      async classifyIntent() {
        return { intent: "coding", provider: "test" };
      }
    }
  });

  const task = repository.findTask(result.task_id);
  assert.equal(result.status, "waiting_approval");
  assert.equal(result.selected_agent.type, "coding");
  assert.match(result.response, /waiting for approval/i);
  assert.equal(task.title, "Build Simple Calculator");
  assert.equal(task.assignedAgentId, "coding-agent");
  assert.equal(task.status, "waiting_approval");
  assert.deepEqual(task.metadata.requirements, [
    "CLI calculator",
    "add/subtract/multiply/divide",
    "input validation",
    "tests"
  ]);
  assert.equal(repository.listApprovals({ status: "pending" }).some((approval) => approval.approvalType === "repo_modification"), true);
  repository.close();
}

async function testChatEscalatesActionRequests() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository)
  });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    orchestrateAction: ({ command, executionClass }) => {
      const workflow = engine.createWorkflow({
        template_id: executionClass === "research_task" ? "research-workflow" : "app-builder",
        name: command,
        goal: command
      });
      const started = engine.startWorkflow(workflow.id);
      return {
        selected_agent: agentRegistry.find((agent) => agent.type === "ceo"),
        status: "queued",
        workflow_id: workflow.id,
        workflow: started.workflow,
        approval_required: false
      };
    }
  });
  const result = await chatAgent.respond({ message: "build calculator app" });
  assert.equal(result.intent, "action_request");
  assert.equal(result.orchestration.status, "queued");
  assert.ok(result.orchestration.workflow_id);
  assert.equal(engine.getWorkflow(result.orchestration.workflow_id).status, "queued");
  assert.doesNotMatch(result.response, /recommend routing|suggest routing/i);
  repository.close();
}

async function testAutomaticExecutionClassificationAndQuickQuery() {
  assert.equal(classifyExecutionRequest("gold rate today"), "quick_query");
  assert.equal(classifyExecutionRequest("latest AI news"), "quick_query");
  assert.equal(classifyExecutionRequest("stock price of MSFT"), "quick_query");
  assert.equal(classifyExecutionRequest("competitor research for my SaaS"), "research_task");
  assert.equal(classifyExecutionRequest("create faceless video about AI"), "generation_task");
  assert.equal(classifyExecutionRequest("deploy SaaS to vercel"), "deployment_task");

  const repository = createDatabaseRepository({ memory: true });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    executeQuickQuery: async ({ message }) => ({
      status: "completed",
      response: `Direct research answer for ${message}\nSources:\n- Market source: https://research.local/market`,
      sources: [{ title: "Market source", url: "https://research.local/market" }]
    })
  });
  const result = await chatAgent.respond({ message: "gold price" });
  assert.equal(result.intent, "quick_query");
  assert.match(result.response, /Direct research answer/);
  assert.equal(result.orchestration.status, "completed");
  assert.doesNotMatch(result.response, /recommend routing|suggest routing|would start by routing/i);
  repository.close();
}

async function testRoutingNarrationNeverAppears() {
  const repository = createDatabaseRepository({ memory: true });
  assert.equal(
    removeRoutingNarration("I recommend routing this query to the WebSearch Agent. The WebSearch Agent can fetch rates. Please let the CEO Agent know to route this query."),
    ""
  );
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    llmProvider: {
      async sendMessage() {
        return {
          text: "I recommend routing this query to the WebSearch Agent. The WebSearch Agent can fetch rates. Please let the CEO Agent know to route this query."
        };
      }
    }
  });
  const result = await chatAgent.respond({ message: "hello" });
  assert.doesNotMatch(result.response, /recommend routing|CEO Agent should|WebSearch Agent can|Please let the CEO Agent|WebSearch Agent|route this query/i);
  repository.close();
}

async function testFailedQuickQueryReturnsConciseError() {
  const repository = createDatabaseRepository({ memory: true });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    executeQuickQuery: async () => {
      throw new Error("research provider failed");
    }
  });
  const result = await chatAgent.respond({ message: "weather today" });
  assert.equal(result.intent, "quick_query");
  assert.equal(result.response, "Execution error: research provider failed");
  assert.doesNotMatch(result.response, /recommend routing|CEO Agent should|WebSearch Agent can|Please let the CEO Agent/i);
  repository.close();
}

async function testResearchRequestQueuesWorkflow() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository)
  });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    orchestrateAction: ({ command, executionClass }) => {
      const workflow = engine.createWorkflow({
        template_id: executionClass === "research_task" ? "research-workflow" : "app-builder",
        name: command,
        goal: command
      });
      const started = engine.startWorkflow(workflow.id);
      return { status: "queued", workflow_id: workflow.id, workflow: started.workflow, approval_required: false };
    }
  });
  const result = await chatAgent.respond({ message: "competitor research for TerminalX" });
  assert.equal(result.intent, "action_request");
  assert.equal(result.orchestration.workflow.templateId, "research-workflow");
  assert.match(result.response, /Workflow created/);
  assert.doesNotMatch(result.response, /recommend routing|suggest routing/i);
  repository.close();
}

function testRuntimeModes() {
  assert.equal(normalizeRuntimeMode("offline_mode"), "OFFLINE_MODE");
  assert.equal(normalizeRuntimeMode("anything_else"), "ONLINE_MODE");

  const previous = process.env.TERMINALX_RUNTIME_MODE;
  const previousProvider = process.env.LLM_PROVIDER;
  process.env.TERMINALX_RUNTIME_MODE = "OFFLINE_MODE";
  delete process.env.LLM_PROVIDER;
  assert.equal(getRuntimeConfig().llm.provider, "ollama");
  if (previous === undefined) {
    delete process.env.TERMINALX_RUNTIME_MODE;
  } else {
    process.env.TERMINALX_RUNTIME_MODE = previous;
  }
  if (previousProvider === undefined) {
    delete process.env.LLM_PROVIDER;
  } else {
    process.env.LLM_PROVIDER = previousProvider;
  }
}

function testDatabaseRepository() {
  assert.equal(migrateSqlite(":memory:").migrated, true);

  const repository = createDatabaseRepository({ memory: true });
  repository.seedAgents(agentRegistry);

  const task = repository.createTask({
    title: "Database smoke task",
    description: "Verify persistent repository shape.",
    assignedAgentId: "ceo-agent"
  });
  assert.ok(task.id.startsWith("task_"));
  assert.equal(repository.findTask(task.id).title, "Database smoke task");

  const event = repository.appendTaskHistory(task.id, "test.event", { ok: true });
  assert.ok(event.id.startsWith("event_"));
  assert.equal(repository.findTask(task.id).history.length, 1);

  const approval = repository.addApproval({
    title: "Database approval",
    approvalType: "write_command",
    riskLevel: "medium",
    requestedBy: "test"
  });
  assert.equal(repository.decideApproval(approval.id, "approved", "test").status, "approved");

  repository.upsertFile({
    id: "file_test",
    task_id: task.id,
    filename: "test.txt",
    path: "test/test.txt",
    mime_type: "text/plain",
    size_bytes: 4,
    provider: "local",
    bucket: "local",
    onlineConfigured: false,
    metadata: {}
  });
  assert.equal(repository.getFile("file_test").filename, "test.txt");
  assert.equal(repository.listFiles({ task_id: task.id }).length, 1);

  repository.appendChatMessage({
    conversationId: "chat_test",
    agentId: "chat-agent",
    role: "user",
    content: "hello",
    metadata: {}
  });
  assert.equal(repository.listConversations("chat_test").messages.length, 1);

  repository.logAction("test.log", { ok: true });
  assert.equal(repository.listLogs()[0].action, "test.log");

  repository.setSetting("system", "test_mode", { enabled: true });
  assert.equal(repository.getSetting("system", "test_mode").value.enabled, true);
  assert.equal(repository.listSettings("system").some((setting) => setting.key === "test_mode"), true);

  const passwordHash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", passwordHash), true);
  assert.equal(verifyPassword("wrong password", passwordHash), false);
  const user = repository.createUser({
    email: "auth-test@terminalx.local",
    passwordHash,
    displayName: "Auth Test",
    role: "operator"
  });
  assert.equal(user.email, "auth-test@terminalx.local");
  assert.equal(safeUser(user).passwordHash, undefined);
  seedRbac(repository);
  repository.assignRole(user.id, "viewer");
  assert.deepEqual(repository.listUserRoles(user.id), ["viewer"]);
  assert.equal(repository.listUserPermissions(user.id).includes("tasks:read"), true);
  assert.equal(repository.listUserPermissions(user.id).includes("tasks:create"), false);
  assert.equal(rolePermissions.admin.includes("settings:manage"), true);

  const token = createSessionToken();
  const tokenHash = hashSessionToken(token);
  repository.createSession({
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + 60000).toISOString()
  });
  assert.equal(repository.findSessionByTokenHash(tokenHash).userId, user.id);
  repository.revokeSession(tokenHash);
  assert.equal(repository.findSessionByTokenHash(tokenHash), null);
  assert.equal(repository.logLoginAudit({
    userId: user.id,
    email: user.email,
    action: "login",
    success: true
  }).success, true);
  repository.close();
}

function testPostgresRepositoryInterface() {
  const queries = [];
  const repository = new PostgresRepository({
    databaseUrl: "postgres://terminalx:secret@example.test:5432/terminalx",
    query(sql, params = []) {
      queries.push({ sql, params });
      if (/insert into tasks/i.test(sql)) {
        return [
          {
            id: params[0],
            title: params[1],
            description: params[2],
            status: params[3],
            assigned_agent_id: params[4],
            intent: params[5],
            approval_required: params[6],
            risk_level: params[7],
            metadata: params[8],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/from task_history/i.test(sql)) {
        return [];
      }
      if (/insert into approvals/i.test(sql)) {
        return [
          {
            id: params[0],
            task_id: params[1],
            title: params[2],
            status: params[3],
            approval_type: params[4],
            risk_level: params[5],
            requested_by: params[6],
            assigned_agent_id: params[7],
            description: params[8],
            proposed_action: params[9],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/insert into files/i.test(sql)) {
        return [
          {
            id: params[0],
            task_id: params[1],
            filename: params[2],
            storage_provider: params[3],
            storage_key: params[4],
            path: params[5],
            mime_type: params[6],
            size: params[7],
            size_bytes: params[8],
            mode: params[9],
            provider: params[10],
            bucket: params[11],
            online_configured: params[12],
            metadata: params[13],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/insert into chat_history/i.test(sql)) {
        return [
          {
            id: params[0],
            conversation_id: params[1],
            agent_id: params[2],
            role: params[3],
            content: params[4],
            metadata: params[5],
            created_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/insert into agent_logs/i.test(sql)) {
        return [
          {
            id: params[0],
            agent_id: params[1],
            action: params[2],
            payload: params[3],
            created_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/insert into settings/i.test(sql)) {
        return [
          {
            id: params[0],
            scope: params[1],
            key: params[2],
            value: params[3],
            is_secret: params[4],
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z"
          }
        ];
      }
      if (/select role_id from user_roles/i.test(sql)) {
        return [{ role_id: "admin" }];
      }
      if (/select distinct rp.permission_name/i.test(sql)) {
        return [{ permission_name: "settings:manage" }];
      }
      return [];
    }
  });

  assert.equal(repository.kind, "postgres");
  assert.equal(repository.config.url.includes("secret"), false);
  assert.equal(repository.createTask({ title: "Postgres task" }).title, "Postgres task");
  assert.equal(repository.addApproval({ title: "Approve", requestedBy: "test" }).title, "Approve");
  assert.equal(repository.upsertFile({
    id: "file_pg",
    filename: "pg.txt",
    path: "pg/pg.txt",
    mime_type: "text/plain",
    size_bytes: 2,
    provider: "local",
    bucket: "local",
    onlineConfigured: false,
    metadata: {}
  }).filename, "pg.txt");
  assert.equal(repository.appendChatMessage({
    conversationId: "chat_pg",
    agentId: "chat-agent",
    role: "user",
    content: "hello",
    metadata: {}
  }).content, "hello");
  assert.equal(repository.logAction("pg.log", { ok: true }).action, "pg.log");
  assert.equal(repository.setSetting("system", "provider", "postgres").value, "postgres");
  assert.deepEqual(repository.listUserRoles("user_pg"), ["admin"]);
  assert.deepEqual(repository.listUserPermissions("user_pg"), ["settings:manage"]);
  assert.ok(queries.length >= 6);
}

async function testFileStorageProviders() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const root = path.join(process.cwd(), "storage/local/files/test-suite");
  const localProvider = new LocalStorageProvider({ root });
  const storageService = createStorageService({
    fileRepository: repository,
    approvalQueue,
    provider: localProvider
  });

  const uploaded = await storageService.upload({
    id: "file_storage_test",
    filename: "hello.txt",
    path: "unit/hello.txt",
    mime_type: "text/plain",
    content: "hello storage"
  });
  assert.equal(uploaded.storage_provider, "local");
  assert.equal(uploaded.storage_key, "unit/hello.txt");
  assert.equal(uploaded.size, 13);

  const read = await storageService.read(uploaded.id);
  assert.equal(read.content, "hello storage");
  assert.equal(storageService.list().length, 1);
  assert.ok((await localProvider.listFiles()).includes("unit/hello.txt"));

  const blockedDelete = await storageService.remove({ fileId: uploaded.id });
  assert.equal(blockedDelete.approval_required, true);
  assert.equal(fs.existsSync(path.join(root, "unit/hello.txt")), true);

  approvalQueue.decide(blockedDelete.approval_id, "approved", "test");
  const deleted = await storageService.remove({ fileId: uploaded.id, approvalId: blockedDelete.approval_id });
  assert.equal(deleted.status, "deleted");
  assert.equal(fs.existsSync(path.join(root, "unit/hello.txt")), false);

  assert.ok(createStorageProvider({ provider: "local", localPath: root }) instanceof LocalStorageProvider);
  assert.ok(createStorageProvider({
    provider: "supabase",
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role",
    supabaseBucket: "terminalx-files"
  }) instanceof SupabaseStorageProvider);
  assert.ok(createStorageProvider({
    provider: "s3",
    s3Endpoint: "https://s3.example.test",
    s3Region: "auto",
    s3Bucket: "terminalx-files",
    s3AccessKeyId: "key",
    s3SecretAccessKey: "secret"
  }) instanceof S3StorageProvider);

  await assert.rejects(
    () => new SupabaseStorageProvider({}).uploadFile({ key: "x.txt", content: Buffer.from("x") }),
    /Supabase storage requires/
  );
  await assert.rejects(
    () => new S3StorageProvider({}).uploadFile({ key: "x.txt", content: Buffer.from("x") }),
    /S3 storage requires/
  );

  repository.close();
}

async function testExecutionWorkspaceTools() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const task = repository.createTask({
    title: "Workspace calculator",
    assignedAgentId: "coding-agent",
    status: "waiting_approval",
    intent: "coding"
  });
  assert.throws(() => resolveWorkspacePath(task.id, "files", "../escape.txt"), /escape blocked/i);

  const registry = createToolRegistry({
    taskId: task.id,
    agentId: "coding-agent",
    approvalQueue,
    logAction: repository.logAction.bind(repository),
    appendTaskHistory: repository.appendTaskHistory.bind(repository)
  });
  await assert.rejects(
    () => registry.execute("file-create", {
      taskId: task.id,
      path: "calculator/index.js",
      content: "console.log('hello')"
    }),
    /requires human\/admin approval/i
  );
  const approval = approvalQueue.add({
    taskId: task.id,
    title: "Approve workspace write",
    approvalType: "repo_modification",
    riskLevel: "medium",
    requestedBy: "coding-agent",
    proposedAction: { proposedFiles: [{ path: "calculator/index.js" }] }
  });
  approvalQueue.decide(approval.id, "approved", "test");
  const created = await registry.execute("file-create", {
    taskId: task.id,
    path: "calculator/index.js",
    content: "console.log('hello')",
    approvalId: approval.id
  });
  assert.equal(created.status, "created");
  assert.equal(registry.listWorkspaceFiles(task.id).some((file) => file.path === "calculator/index.js"), true);
  repository.close();
}

async function testDynamicCodingGeneration() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const task = repository.createTask({
    title: "Build API Server",
    description: "Create a lightweight API server with health endpoint and tests",
    assignedAgentId: "coding-agent",
    status: "created",
    intent: "coding",
    metadata: { requirements: ["API server", "health endpoint", "tests"] }
  });
  const planned = codingAgent.executeAssignedTask({
    task,
    command: task.description,
    approvalQueue
  });
  assert.equal(planned.approval_required, true);
  assert.equal(planned.proposed_files.some((file) => /package\.json$/.test(file.path)), true);
  assert.equal(planned.proposed_files.some((file) => /server\.test\.js$/.test(file.path)), true);

  const approval = approvalQueue.get(planned.approval_id);
  approvalQueue.decide(approval.id, "approved", "test");
  const result = await codingAgent.completeApprovedTask({
    task,
    approval,
    toolRegistry: createToolRegistry({
      taskId: task.id,
      agentId: "coding-agent",
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository)
    }),
    storeFile: async (filePayload) => repository.upsertFile({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      task_id: filePayload.task_id,
      filename: filePayload.filename,
      path: filePayload.path,
      mime_type: filePayload.mime_type,
      size_bytes: Buffer.byteLength(filePayload.content || ""),
      provider: "local",
      bucket: "local",
      onlineConfigured: false,
      metadata: filePayload.metadata || {}
    })
  });
  assert.equal(result.status, "completed");
  assert.equal(result.test_result.status, "passed");
  assert.equal(result.files.some((file) => /package\.json$/.test(file.path)), true);
  assert.equal(result.files.some((file) => /server\.js$/.test(file.path)), true);
  assert.equal(result.logs.includes("generating"), true);
  assert.equal(result.logs.includes("testing"), true);
  assert.equal(result.logs.includes("saving_outputs"), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(task.id, "outputs", "result.json").resolved), true);
  repository.close();
}

async function testCodingAgentSelfFixLoop() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const task = repository.createTask({
    title: "Build Self-Fix API Server",
    description: "Create an API server with self-fix initial failure and tests",
    assignedAgentId: "coding-agent",
    status: "created",
    intent: "coding",
    metadata: { requirements: ["API server", "self-fix initial failure", "tests"] }
  });
  const planned = codingAgent.executeAssignedTask({ task, command: task.description, approvalQueue });
  const approval = approvalQueue.get(planned.approval_id);
  approvalQueue.decide(approval.id, "approved", "test");
  const result = await codingAgent.completeApprovedTask({
    task,
    approval,
    toolRegistry: createToolRegistry({
      taskId: task.id,
      agentId: "coding-agent",
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository)
    }),
    storeFile: async (filePayload) => repository.upsertFile({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      task_id: filePayload.task_id,
      filename: filePayload.filename,
      path: filePayload.path,
      mime_type: filePayload.mime_type,
      size_bytes: Buffer.byteLength(filePayload.content || ""),
      provider: "local",
      bucket: "local",
      onlineConfigured: false,
      metadata: filePayload.metadata || {}
    })
  });
  assert.equal(result.status, "completed");
  assert.equal(result.test_result.status, "passed");
  assert.equal(result.logs.includes("fixing"), true);
  assert.equal(result.logs.includes("retesting"), true);
  assert.equal(result.fix_attempts.length, 1);
  assert.equal(Math.max(...result.iterations.map((entry) => entry.iteration)) <= 3, true);
  const output = fs.readFileSync(resolveWorkspacePath(task.id, "outputs", "result.json").resolved, "utf8");
  assert.match(output, /iterationHistory/);
  repository.close();
}

async function testCodingAgentRetryLimitEnforced() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const task = repository.createTask({
    title: "Build Unfixable Utility",
    description: "Create generic implementation with tests",
    assignedAgentId: "coding-agent",
    status: "created",
    intent: "coding"
  });
  const approval = approvalQueue.add({
    taskId: task.id,
    title: "Approve unfixable generated test",
    approvalType: "repo_modification",
    riskLevel: "medium",
    requestedBy: "coding-agent",
    proposedAction: {
      command: task.description,
      proposedFiles: [
        { path: "terminalx-generated/unfixable/index.js", purpose: "Implementation" },
        { path: "terminalx-generated/unfixable/index.test.js", purpose: "Intentionally unfixable test", test: true }
      ]
    }
  });
  approvalQueue.decide(approval.id, "approved", "test");
  const result = await codingAgent.completeApprovedTask({
    task,
    approval,
    toolRegistry: createToolRegistry({
      taskId: task.id,
      agentId: "coding-agent",
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository)
    }),
    storeFile: async (filePayload) => repository.upsertFile({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      task_id: filePayload.task_id,
      filename: filePayload.filename,
      path: filePayload.path,
      mime_type: filePayload.mime_type,
      size_bytes: Buffer.byteLength(filePayload.content || ""),
      provider: "local",
      bucket: "local",
      onlineConfigured: false,
      metadata: filePayload.metadata || {}
    })
  });
  assert.equal(result.status, "failed");
  assert.equal(Math.max(...result.iterations.map((entry) => entry.iteration)) <= 3, true);
  assert.equal(result.logs.includes("failed"), true);
  repository.close();
}

function testWorkflowEngine() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository)
  });
  const bot = engine.createBot({
    name: "Research Bot",
    goal: "Find useful topics",
    tools: ["web-search"],
    memory_enabled: true,
    schedules: ["daily"],
    approval_policy: "human_required_for_risky_actions"
  });
  assert.equal(engine.listBots()[0].name, "Research Bot");
  assert.equal(engine.getBotMemory(bot.id).history.length, 0);
  engine.saveBotMemory(bot.id, { preferences: { tone: "direct" }, reusablePrompts: ["Summarize findings"] });
  assert.equal(engine.getBotMemory(bot.id).preferences.tone, "direct");
  assert.equal(engine.templates().some((template) => template.id === "app-builder"), true);
  assert.equal(engine.integrations().some((integration) => integration.id === "gmail"), true);

  const workflow = engine.createWorkflow({ template_id: "app-builder", name: "Build app workflow" });
  const started = engine.startWorkflow(workflow.id);
  assert.equal(started.job.status, "queued");
  const firstTick = engine.tickWorker();
  assert.equal(firstTick.workflow.steps[0].status, "completed");
  const secondTick = engine.tickWorker();
  assert.equal(secondTick.workflow.status, "waiting_approval");
  assert.equal(approvalQueue.list({ status: "pending" }).some((approval) => approval.requestedBy === "workflow-engine"), true);
  assert.equal(engine.listJobs().some((job) => job.status === "waiting_approval"), true);
  repository.close();
}

async function testWorkflowCodingApprovalResume() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    executeCodingTask: codingAgent.executeAssignedTask
  });
  const workflow = engine.createWorkflow({ template_id: "app-builder", name: "Workflow calculator", goal: "create calculator app" });
  engine.startWorkflow(workflow.id);
  engine.tickWorker();
  const paused = engine.tickWorker();
  assert.equal(paused.workflow.status, "waiting_approval");
  const task = repository.listTasks().find((entry) => entry.metadata?.workflow_id === workflow.id);
  const approval = approvalQueue.list({ status: "pending" }).find((entry) => entry.taskId === task.id);
  approvalQueue.decide(approval.id, "approved", "test");
  const result = await codingAgent.completeApprovedTask({
    task,
    approval,
    toolRegistry: createToolRegistry({
      taskId: task.id,
      agentId: "coding-agent",
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository)
    }),
    storeFile: async (filePayload) => repository.upsertFile({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      task_id: filePayload.task_id,
      filename: filePayload.filename,
      path: filePayload.path,
      mime_type: filePayload.mime_type,
      size_bytes: Buffer.byteLength(filePayload.content || ""),
      provider: "local",
      bucket: "local",
      onlineConfigured: false,
      metadata: filePayload.metadata || {}
    })
  });
  const resumed = engine.resumeCodingTask(task, result);
  assert.equal(result.status, "completed");
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.steps.find((step) => step.id === "code").status, "completed");
  assert.equal(resumed.steps.find((step) => step.id === "test").status, "completed");
  assert.equal(engine.listJobs().some((job) => job.workflowId === workflow.id && job.status === "completed"), true);
  repository.close();
}

async function testAsyncWorkflowBackgroundExecution() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository)
  });
  const workflow = engine.createWorkflow({ template_id: "research-workflow", name: "Async research", goal: "async workflow" });
  const started = engine.startWorkflow(workflow.id);
  assert.equal(started.workflow.status, "queued");
  assert.equal(engine.getWorkflow(workflow.id).steps.every((step) => step.status === "pending"), true);
  let tick = await engine.runBackgroundOnce();
  assert.equal(["running", "completed"].includes(tick.workflow.status), true);
  assert.equal(tick.workflow.timeline.some((event) => ["queued", "researching", "executing"].includes(event.status)), true);
  tick = await engine.runBackgroundOnce();
  tick = await engine.runBackgroundOnce();
  assert.equal(tick.workflow.status, "completed");
  repository.close();
}

async function testWorkflowConcurrencyAndTimeout() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  let releaseSlowStep;
  const slowStep = new Promise((resolve) => {
    releaseSlowStep = resolve;
  });
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    maxConcurrentWorkflows: 1,
    workflowTimeoutMs: 1000,
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      searchProvider: async () => [{ url: "https://slow.test/1", title: "Slow", snippet: "Slow" }],
      fetchPage: async () => {
        await slowStep;
        return "<html><title>slow</title><body>slow research</body></html>";
      }
    })
  });
  const workflow = engine.createWorkflow({ template_id: "research-workflow", name: "Slow research", goal: "slow" });
  engine.startWorkflow(workflow.id);
  const firstTick = engine.tickWorkerAsync();
  const busy = await engine.tickWorkerAsync();
  assert.equal(busy.status, "busy");
  releaseSlowStep();
  await firstTick;

  const timeoutRepository = createDatabaseRepository({ memory: true });
  const timeoutApprovalQueue = createApprovalQueue(timeoutRepository);
  const timeoutEngine = createWorkflowEngine({
    repository: timeoutRepository,
    approvalQueue: timeoutApprovalQueue,
    appendTaskHistory: timeoutRepository.appendTaskHistory.bind(timeoutRepository),
    createTask: timeoutRepository.createTask.bind(timeoutRepository),
    workflowTimeoutMs: 1,
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue: timeoutApprovalQueue,
      logAction: timeoutRepository.logAction.bind(timeoutRepository),
      appendTaskHistory: timeoutRepository.appendTaskHistory.bind(timeoutRepository),
      searchProvider: async () => [{ url: "https://timeout.test/1", title: "Timeout", snippet: "Timeout" }],
      fetchPage: async () => new Promise((resolve) => setTimeout(() => resolve("<html><body>late</body></html>"), 20))
    })
  });
  const timeoutWorkflow = timeoutEngine.createWorkflow({ template_id: "research-workflow", name: "Timeout research", goal: "timeout", retry_limit: 0 });
  timeoutEngine.startWorkflow(timeoutWorkflow.id);
  const timedOut = await timeoutEngine.tickWorkerAsync();
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.activeJob.error, /timed out/i);
  repository.close();
  timeoutRepository.close();
}

async function testResearchWorkflowCompletes() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const fetchAttempts = {};
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      fetchPage: async (url, attempt) => {
        fetchAttempts[url] = attempt;
        if (url.includes("/1") && attempt === 1) {
          throw new Error("temporary fetch failure");
        }
        return `<html><title>${url} title</title><body>${url} useful research about AI agents, workflows, and automation.</body></html>`;
      }
    })
  });
  const workflow = engine.createWorkflow({
    template_id: "research-workflow",
    name: "Research AI agents",
    goal: "AI agent workflow automation",
    context: { topic: "AI agent workflow automation" }
  });
  engine.startWorkflow(workflow.id);
  let tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();

  assert.equal(tick.workflow.status, "completed");
  assert.equal(tick.workflow.context.search.sources.length, 3);
  assert.equal(Object.values(fetchAttempts).some((attempt) => attempt === 2), true);
  const taskId = `workflow-${workflow.id}`;
  const summaryPath = resolveWorkspacePath(taskId, "outputs", "research-summary.md").resolved;
  const sourcesPath = resolveWorkspacePath(taskId, "outputs", "sources.json").resolved;
  assert.equal(fs.existsSync(summaryPath), true);
  assert.equal(fs.existsSync(sourcesPath), true);
  assert.match(fs.readFileSync(summaryPath, "utf8"), /Research Summary/);
  const sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  assert.equal(sources.sources.length, 3);
  assert.equal(sources.sources[0].attempts, 2);
  repository.close();
}

async function testContentEngineWorkflowCompletes() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  let scriptAttempts = 0;
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      searchProvider: async (query, limit) => Array.from({ length: limit }, (_unused, index) => ({
        url: `https://content.test/${index + 1}`,
        title: `${query} source ${index + 1}`,
        snippet: `${query} useful source ${index + 1}`
      })),
      fetchPage: async (url) => `<html><title>${url}</title><body>${url} has practical AI news and automation context.</body></html>`,
      contentProvider: {
        async generateScript(input) {
          scriptAttempts += 1;
          if (scriptAttempts === 1) throw new Error("temporary content generation failure");
          return `# ${input.topic}\n\nGenerated after retry for ${input.format}.`;
        }
      }
    })
  });
  assert.equal(engine.templates().some((template) => template.id === "youtube-video"), true);
  assert.equal(engine.templates().find((template) => template.id === "youtube-video").steps.some((step) => step.target === "external_upload"), true);
  assert.equal(engine.templates().find((template) => template.id === "twitter-thread").steps.some((step) => step.target === "social_posting"), true);

  const workflow = engine.createWorkflow({
    template_id: "ai-news-summary",
    name: "AI News Package",
    goal: "AI agent automation news",
    context: { topic: "AI agent automation news" }
  });
  engine.startWorkflow(workflow.id);
  let tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();

  assert.equal(tick.workflow.status, "completed");
  assert.equal(scriptAttempts, 2);
  assert.equal(tick.workflow.context.content.metadata.tags.includes("terminalx"), true);
  const taskId = `workflow-${workflow.id}`;
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "script.md").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "metadata.json").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "thumbnail-prompt.txt").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "generated-images/thumbnail.svg").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "content-package.json").resolved), true);
  const metadata = JSON.parse(fs.readFileSync(resolveWorkspacePath(taskId, "outputs", "metadata.json").resolved, "utf8"));
  assert.match(metadata.title, /AI Agent Automation News/i);
  assert.equal(metadata.sources.length, 3);
  repository.close();
}

async function testVoiceVideoPipelineCompletes() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  let voiceAttempts = 0;
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      searchProvider: async (query, limit) => Array.from({ length: limit }, (_unused, index) => ({
        url: `https://video.test/${index + 1}`,
        title: `${query} video source ${index + 1}`,
        snippet: `${query} video source ${index + 1}`
      })),
      fetchPage: async (url) => `<html><title>${url}</title><body>${url} faceless video research notes.</body></html>`,
      mediaProvider: {
        async generateVoice(input) {
          voiceAttempts += 1;
          if (voiceAttempts === 1) throw new Error("temporary voice failure");
          return `MP3\nvoice retry ok\n${String(input.script).slice(0, 80)}`;
        }
      }
    })
  });
  assert.equal(engine.templates().some((template) => template.id === "faceless-youtube-video"), true);
  const workflow = engine.createWorkflow({
    template_id: "faceless-youtube-video",
    name: "Faceless AI Video",
    goal: "AI tools for small business",
    context: { topic: "AI tools for small business" }
  });
  engine.startWorkflow(workflow.id);
  let tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();
  tick = await engine.tickWorkerAsync();

  assert.equal(tick.workflow.status, "waiting_approval");
  assert.equal(voiceAttempts, 2);
  assert.equal(tick.workflow.context.media.videoPackage.status, "exported");
  const taskId = `workflow-${workflow.id}`;
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "narration.mp3").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "subtitles.srt").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "video-package.json").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "final-video.mp4").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "render-logs.txt").resolved), true);
  assert.match(fs.readFileSync(resolveWorkspacePath(taskId, "outputs", "subtitles.srt").resolved, "utf8"), /-->/);
  assert.equal(approvalQueue.list({ status: "pending" }).some((approval) => approval.approvalType === "external_upload"), true);
  repository.close();
}

async function testGithubDeploymentToolsAndWorkflow() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const calls = [];
  let deployAttempts = 0;
  const githubProvider = {
    async createRepo(input) {
      calls.push("createRepo");
      return { repo: input.name, repoUrl: `https://github.com/terminalx/${input.name}` };
    },
    async writeFiles(input) {
      calls.push("writeFiles");
      return { repo: input.repo, writtenFiles: input.files.length };
    },
    async commit() {
      calls.push("commit");
      return { commitSha: "abc123" };
    },
    async push(input) {
      calls.push("push");
      return { repoUrl: input.repoUrl || `https://github.com/terminalx/${input.repo}` };
    }
  };
  const deploymentProvider = {
    async deploy(input) {
      deployAttempts += 1;
      calls.push(`deploy-${deployAttempts}`);
      if (deployAttempts === 1) throw new Error("temporary deploy failure");
      return {
        deploymentId: "dep_123",
        deploymentUrl: "https://terminalx-test.vercel.app",
        logs: ["deploy started", "deploy ready"]
      };
    },
    async status() {
      calls.push("status");
      return { status: "ready", deploymentUrl: "https://terminalx-test.vercel.app" };
    }
  };
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    executeCodingTask: codingAgent.executeAssignedTask,
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      githubProvider,
      deploymentProvider
    })
  });

  const workflow = engine.createWorkflow({ template_id: "deploy-app", name: "Deploy Todo", goal: "create todo app" });
  engine.startWorkflow(workflow.id);
  engine.tickWorker();
  let tick = engine.tickWorker();
  const buildTask = repository.listTasks().find((task) => task.metadata?.workflow_id === workflow.id);
  const buildApproval = approvalQueue.list({ status: "pending" }).find((approval) => approval.taskId === buildTask.id);
  approvalQueue.decide(buildApproval.id, "approved", "test");
  const buildResult = await codingAgent.completeApprovedTask({
    task: buildTask,
    approval: buildApproval,
    toolRegistry: createToolRegistry({
      taskId: buildTask.id,
      agentId: "coding-agent",
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository)
    }),
    storeFile: async (filePayload) => repository.upsertFile({
      id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      task_id: filePayload.task_id,
      filename: filePayload.filename,
      path: filePayload.path,
      mime_type: filePayload.mime_type,
      size_bytes: Buffer.byteLength(filePayload.content || ""),
      provider: "local",
      bucket: "local",
      onlineConfigured: false,
      metadata: filePayload.metadata || {}
    })
  });
  engine.resumeCodingTask(buildTask, buildResult);
  tick = await engine.tickWorkerAsync();
  assert.equal(tick.workflow.status, "waiting_approval");
  const releaseApproval = approvalQueue.list({ status: "pending" }).find((approval) => approval.proposedAction?.workflow_id === workflow.id);
  assert.ok(releaseApproval);
  const approvedRelease = approvalQueue.decide(releaseApproval.id, "approved", "test");
  engine.resumeApproval(approvedRelease);
  for (let index = 0; index < 6; index += 1) {
    tick = await engine.tickWorkerAsync();
    if (tick.workflow?.status === "completed") break;
  }
  const finalWorkflow = tick.workflow || engine.getWorkflow(workflow.id);
  assert.equal(finalWorkflow.status, "completed");
  assert.equal(finalWorkflow.context.repo.repoUrl, "https://github.com/terminalx/deploy-todo");
  assert.equal(finalWorkflow.context.deploy.deploymentUrl, "https://terminalx-test.vercel.app");
  assert.equal(finalWorkflow.context.deploy.attempts, 2);
  assert.equal(finalWorkflow.context.status.status, "ready");
  assert.deepEqual(calls, ["createRepo", "writeFiles", "commit", "push", "deploy-1", "deploy-2", "status"]);
  repository.close();
}

async function testBrowserAutomationLayer() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const taskId = "browser_test_task";
  let openAttempts = 0;
  const browserProvider = {
    async open(input) {
      openAttempts += 1;
      if (openAttempts === 1) throw new Error("temporary browser failure");
      return { url: input.url, title: "Example Page" };
    },
    async click(input) {
      return { selector: input.selector };
    },
    async type(input) {
      return { selector: input.selector, length: input.text.length };
    },
    async screenshot() {
      return { content: "screenshot-bytes" };
    },
    async extractText() {
      return { text: "Example Page\nUseful extracted browser text." };
    },
    async close(input) {
      return { sessionId: input.sessionId };
    }
  };
  const registry = createToolRegistry({
    taskId,
    agentId: "browser-agent",
    approvalQueue,
    logAction: repository.logAction.bind(repository),
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    browserProvider
  });

  const opened = await registry.execute("browser-open", { url: "https://example.test", sessionId: "s1", retries: 2 });
  assert.equal(opened.status, "opened");
  assert.equal(opened.attempts, 2);
  const extracted = await registry.execute("browser-extract-text", { sessionId: "s1", filename: "browser-text.txt" });
  assert.match(extracted.text, /Useful extracted/);
  const screenshot = await registry.execute("browser-screenshot", { sessionId: "s1", filename: "shot.txt" });
  assert.equal(screenshot.status, "captured");
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "browser-text.txt").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "shot.txt").resolved), true);
  await assert.rejects(
    () => registry.execute("browser-click", { sessionId: "s1", selector: "button[type=submit]" }),
    /requires human\/admin approval/i
  );
  const approval = approvalQueue.add({ title: "Approve submit click", approvalType: "browser_action", riskLevel: "high", requestedBy: "browser-agent" });
  approvalQueue.decide(approval.id, "approved", "test");
  assert.equal((await registry.execute("browser-click", { sessionId: "s1", selector: "button[type=submit]", approvalId: approval.id })).status, "clicked");
  await registry.execute("browser-close", { sessionId: "s1" });
  repository.close();
}

async function testBrowserWorkflowCompletes() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const engine = createWorkflowEngine({
    repository,
    approvalQueue,
    appendTaskHistory: repository.appendTaskHistory.bind(repository),
    createTask: repository.createTask.bind(repository),
    toolRegistryFactory: (taskId, agentId) => createToolRegistry({
      taskId,
      agentId,
      approvalQueue,
      logAction: repository.logAction.bind(repository),
      appendTaskHistory: repository.appendTaskHistory.bind(repository),
      browserProvider: {
        async open(input) { return { url: input.url, title: "Workflow Page" }; },
        async screenshot() { return { content: "workflow-shot" }; },
        async extractText() { return { text: "Workflow extracted text" }; },
        async close(input) { return { sessionId: input.sessionId }; }
      }
    })
  });
  const workflow = engine.createWorkflow({ template_id: "browser-workflow", name: "Browse Example", goal: "https://example.test" });
  engine.startWorkflow(workflow.id);
  const tick = await engine.tickWorkerAsync();
  assert.equal(tick.workflow.status, "completed");
  const taskId = `workflow-${workflow.id}`;
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "browser-screenshot.txt").resolved), true);
  assert.equal(fs.existsSync(resolveWorkspacePath(taskId, "outputs", "browser-text.txt").resolved), true);
  assert.match(tick.workflow.context.browse.extracted.text, /Workflow extracted/);
  repository.close();
}

async function testAiProviders() {
  const previousProvider = process.env.LLM_PROVIDER;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousGeminiKey = process.env.GEMINI_API_KEY;
  const previousGroqKey = process.env.GROQ_API_KEY;
  const previousGroqModel = process.env.GROQ_MODEL;
  const previousOllamaModel = process.env.OLLAMA_MODEL;

  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  process.env.LLM_PROVIDER = "auto";

  const provider = createLlmProvider();
  assert.equal(provider.describe().id, "mock");
  assert.equal((await provider.classifyIntent("implement a backend route")).intent, "coding");
  assert.equal(parseIntentFromText('{"intent":"testing"}'), "testing");
  assert.equal(parseIntentFromText("route to content"), "content");
  process.env.OLLAMA_MODEL = "llama3:test";
  const ollama = new OllamaProvider(getRuntimeConfig());
  assert.equal(ollama.describe().id, "ollama");
  assert.equal(ollama.describe().available, true);
  assert.equal(ollama.describe().model, "llama3:test");
  process.env.GROQ_MODEL = "llama-3.3-70b-versatile";
  const groq = new GroqProvider(getRuntimeConfig());
  assert.equal(groq.describe().id, "groq");
  assert.equal(groq.describe().available, false);
  assert.equal(groq.describe().model, "llama-3.3-70b-versatile");

  if (previousProvider === undefined) {
    delete process.env.LLM_PROVIDER;
  } else {
    process.env.LLM_PROVIDER = previousProvider;
  }
  if (previousOpenAiKey !== undefined) {
    process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
  if (previousAnthropicKey !== undefined) {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  }
  if (previousGeminiKey !== undefined) {
    process.env.GEMINI_API_KEY = previousGeminiKey;
  }
  if (previousGroqKey !== undefined) {
    process.env.GROQ_API_KEY = previousGroqKey;
  }
  if (previousGroqModel === undefined) {
    delete process.env.GROQ_MODEL;
  } else {
    process.env.GROQ_MODEL = previousGroqModel;
  }
  if (previousOllamaModel === undefined) {
    delete process.env.OLLAMA_MODEL;
  } else {
    process.env.OLLAMA_MODEL = previousOllamaModel;
  }
}

async function testAgentOrchestrator() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId)
  });
  const orchestrator = createAgentOrchestrator({
    repository,
    approvalQueue,
    chatAgent,
    workspaceRoot: process.cwd()
  });
  const task = repository.createTask({
    title: "Orchestrate chat",
    description: "plan next step",
    assignedAgentId: "chat-agent",
    intent: "chat"
  });
  const agent = agentRegistry.find((entry) => entry.type === "chat");
  const result = await orchestrator.execute({
    taskId: task.id,
    agent,
    command: "plan next step"
  });
  const storedTask = repository.findTask(task.id);
  assert.equal(result.status, TASK_STATUSES.COMPLETED);
  assert.equal(storedTask.status, TASK_STATUSES.COMPLETED);
  assert.equal(storedTask.history.some((event) => event.eventType === "agent.result"), true);

  const approvalTask = repository.createTask({
    title: "Approval task",
    assignedAgentId: "coding-agent",
    intent: "coding"
  });
  const codingAgent = agentRegistry.find((entry) => entry.type === "coding");
  const paused = await orchestrator.execute({
    taskId: approvalTask.id,
    agent: codingAgent,
    command: "delete file important.txt",
    approvalRequired: true,
    approvalId: "approval_test"
  });
  assert.equal(paused.status, TASK_STATUSES.WAITING_APPROVAL);
  assert.equal(repository.findTask(approvalTask.id).status, TASK_STATUSES.WAITING_APPROVAL);
  repository.close();
}

async function testChatAgentUsesLlmProvider() {
  const repository = createDatabaseRepository({ memory: true });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    llmProvider: {
      async sendMessage(payload) {
        return {
          provider: "test",
          text: `LLM says: ${payload.message.includes("hello") ? "hello" : "ok"}`
        };
      }
    }
  });
  const result = await chatAgent.respond({ message: "hello from test" });
  assert.equal(result.response, "LLM says: hello");
  assert.equal(repository.listConversations(result.conversation_id).messages.length, 2);
  repository.close();
}

async function testChatStatusUsesSystemSnapshot() {
  const repository = createDatabaseRepository({ memory: true });
  repository.createTask({
    title: "Status smoke task",
    assignedAgentId: "coding-agent",
    status: "running",
    intent: "coding"
  });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    getSystemStatus: () => ({
      agents: agentRegistry,
      tasks: repository.listTasks(),
      approvals: []
    }),
    llmProvider: {
      async sendMessage() {
        throw new Error("Status should not call LLM");
      }
    }
  });
  const result = await chatAgent.respond({ message: "CEO, what is the current status of all agents?" });
  assert.equal(result.intent, "agent_status");
  assert.match(result.response, /CEO Agent agent status report/);
  assert.match(result.response, /Coding Agent/);
  repository.close();
}

async function testTaskSpecificStatusSearch() {
  const repository = createDatabaseRepository({ memory: true });
  const approvalQueue = createApprovalQueue(repository);
  const calculatorTask = repository.createTask({
    title: "Build Calculator App",
    description: "User request: create a calculator app",
    assignedAgentId: "coding-agent",
    status: "running",
    intent: "coding",
    metadata: {
      requirements: ["CLI calculator", "add/subtract/multiply/divide", "input validation", "tests"]
    }
  });
  repository.createTask({
    title: "Chat Agent: hello",
    description: "hello",
    assignedAgentId: "chat-agent",
    status: "completed",
    intent: "chat"
  });
  approvalQueue.add({
    taskId: calculatorTask.id,
    title: "Approve Coding Agent file generation for Build Calculator App",
    approvalType: "repo_modification",
    riskLevel: "medium",
    requestedBy: "coding-agent"
  });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    getSystemStatus: () => ({
      agents: agentRegistry,
      tasks: repository.listTasks(),
      approvals: approvalQueue.list({ status: "pending" })
    }),
    llmProvider: {
      async sendMessage() {
        throw new Error("Task status should not call LLM");
      }
    }
  });
  const result = await chatAgent.respond({ message: "status of calculator app" });
  assert.equal(result.intent, "task_status");
  assert.equal(result.status_report.task.title, "Build Calculator App");
  assert.equal(result.status_report.task.current_status, "waiting_approval");
  assert.match(result.response, /Build Calculator App/);
  assert.match(result.response, /Approval required/);
  assert.doesNotMatch(result.response, /Chat Agent: hello/);
  repository.close();
}

async function testStatusReportDedupesRepeatedChatTasks() {
  const repository = createDatabaseRepository({ memory: true });
  for (let index = 0; index < 3; index += 1) {
    repository.createTask({
      title: "Chat Agent: hello",
      description: "hello",
      assignedAgentId: "chat-agent",
      status: "completed",
      intent: "chat"
    });
  }
  repository.createTask({
    title: "Build Calculator App",
    assignedAgentId: "coding-agent",
    status: "waiting_approval",
    intent: "coding"
  });
  const chatAgent = createChatAgent({
    conversationRepository: repository,
    storageService: { read: async () => null },
    findTask: (taskId) => repository.findTask(taskId),
    getSystemStatus: () => ({
      agents: agentRegistry,
      tasks: repository.listTasks(),
      approvals: []
    })
  });
  const result = await chatAgent.respond({ message: "what is going on" });
  assert.equal(result.intent, "system_status");
  assert.match(result.response, /Latest unique tasks/);
  assert.equal((result.response.match(/Chat Agent: hello/g) || []).length, 1);
  assert.match(result.response, /waiting_approval: 1/);
  repository.close();
}

function waitForServer(baseUrl, child) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error("Test server exited before becoming ready."));
        return;
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          clearInterval(timer);
          resolve();
        }
      } catch {
        if (Date.now() - startedAt > 10000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for test server."));
        }
      }
    }, 250);
  });
}

async function request(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}

async function login(baseUrl, email, password) {
  const result = await request(baseUrl, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });
  const cookie = result.response.headers.get("set-cookie") || "";
  const token = cookie.split(";")[0].split("=")[1];
  return { ...result, token };
}

async function testRbacHttpFlow() {
  const port = 8799;
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(process.cwd(), "tmp", `rbac-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const child = spawn(process.execPath, ["services/api/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AUTH_REQUIRED: "true",
      DATABASE_PROVIDER: "sqlite",
      SQLITE_PATH: dbPath,
      LLM_PROVIDER: "mock",
      TERMINALX_PORT: String(port),
      TERMINALX_ENV: "development",
      ADMIN_EMAIL: "admin@terminalx.local",
      ADMIN_PASSWORD: "change-me-now"
    },
    windowsHide: true
  });

  try {
    await waitForServer(baseUrl, child);

    const unauthorized = await request(baseUrl, "/api/tasks");
    assert.equal(unauthorized.response.status, 401);

    const adminLogin = await login(baseUrl, "admin@terminalx.local", "change-me-now");
    assert.equal(adminLogin.response.status, 200);
    const adminHeaders = { authorization: `Bearer ${adminLogin.token}` };
    const adminPermissions = await request(baseUrl, "/api/auth/permissions", { headers: adminHeaders });
    assert.equal(adminPermissions.body.permissions.includes("settings:manage"), true);
    assert.equal((await request(baseUrl, "/api/tasks", { headers: adminHeaders })).response.status, 200);
    assert.equal(
      (await request(baseUrl, "/api/tasks", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ title: "Admin task" })
      })).response.status,
      201
    );
    const taskSearch = await request(baseUrl, "/api/tasks/search?q=admin", { headers: adminHeaders });
    assert.equal(taskSearch.response.status, 200);
    assert.equal(taskSearch.body.tasks.some((task) => task.title === "Admin task"), true);
    const commandResult = await request(baseUrl, "/api/command", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ command: "help me plan my day" })
    });
    assert.equal(commandResult.response.status, 201);
    assert.equal(commandResult.body.status, "completed");

    const buildResult = await request(baseUrl, "/api/command", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ command: "create simple calculator app" })
    });
    assert.equal(buildResult.response.status, 202);
    assert.equal(buildResult.body.status, "queued");
    await request(baseUrl, "/api/workflows/worker/tick", {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    await request(baseUrl, "/api/workflows/worker/tick", {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    const pendingApprovals = await request(baseUrl, "/api/approvals?status=pending", { headers: adminHeaders });
    const calculatorApproval = pendingApprovals.body.approvals.find((approval) => approval.approvalType === "repo_modification");
    assert.ok(calculatorApproval, "Calculator approval should be visible to the admin.");
    assert.equal(calculatorApproval.requestedBy, "coding-agent");
    assert.equal(calculatorApproval.proposedAction.proposedFiles.length, 3);
    const approved = await request(baseUrl, `/api/approvals/${calculatorApproval.id}/approve`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ decidedBy: "admin-test" })
    });
    assert.equal(approved.response.status, 200);
    assert.equal(approved.body.resumed.status, "completed");
    const calculatorSearch = await request(baseUrl, "/api/tasks/search?q=calculator", { headers: adminHeaders });
    assert.equal(calculatorSearch.body.tasks[0].status, "completed");
    const generatedFiles = await request(baseUrl, `/api/files?task_id=${calculatorSearch.body.tasks[0].id}`, { headers: adminHeaders });
    assert.equal(generatedFiles.body.files.length >= 3, true);
    const workspace = await request(baseUrl, `/api/workspaces/${calculatorSearch.body.tasks[0].id}`, { headers: adminHeaders });
    assert.equal(workspace.response.status, 200);
    assert.match(workspace.body.workspace.path, /storage\/workspaces\/projects/);
    const workspaceFiles = await request(baseUrl, `/api/workspaces/${calculatorSearch.body.tasks[0].id}/files`, { headers: adminHeaders });
    assert.equal(workspaceFiles.body.files.some((file) => /calculator\.js$/.test(file.path)), true);
    const workspaceLogs = await request(baseUrl, `/api/workspaces/${calculatorSearch.body.tasks[0].id}/logs`, { headers: adminHeaders });
    assert.equal(workspaceLogs.response.status, 200);

    const templatesResponse = await request(baseUrl, "/api/workflows/templates", { headers: adminHeaders });
    assert.equal(templatesResponse.body.templates.some((template) => template.id === "youtube-automation"), true);
    const botResponse = await request(baseUrl, "/api/bots", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Lead Bot", goal: "Find leads", tools: ["web-search"], memory_enabled: true })
    });
    assert.equal(botResponse.response.status, 201);
    const memoryResponse = await request(baseUrl, `/api/bots/${botResponse.body.bot.id}/memory`, { headers: adminHeaders });
    assert.equal(memoryResponse.body.memory.botId, botResponse.body.bot.id);
    const workflowResponse = await request(baseUrl, "/api/workflows", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ template_id: "research-workflow", name: "Research smoke" })
    });
    assert.equal(workflowResponse.response.status, 201);
    const runWorkflow = await request(baseUrl, `/api/workflows/${workflowResponse.body.workflow.id}/run`, {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    assert.equal(runWorkflow.response.status, 202);
    const workerTick = await request(baseUrl, "/api/workflows/worker/tick", {
      method: "POST",
      headers: adminHeaders,
      body: "{}"
    });
    assert.equal(["running", "completed", "waiting_approval"].includes(workerTick.body.status), true);
    const integrationsResponse = await request(baseUrl, "/api/integrations", { headers: adminHeaders });
    assert.equal(integrationsResponse.body.integrations.some((integration) => integration.id === "github"), true);

    const viewerEmail = `viewer-${Date.now()}@terminalx.local`;
    const viewerRegister = await request(baseUrl, "/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ email: viewerEmail, password: "password-123" })
    });
    assert.equal(viewerRegister.response.status, 201);
    // Registered users default to operator; create a viewer through repository for exact role coverage.
    const repository = createDatabaseRepository({ databasePath: dbPath });
    const viewer = repository.upsertUser({
      email: `viewer-only-${Date.now()}@terminalx.local`,
      passwordHash: hashPassword("password-123"),
      displayName: "Viewer",
      role: "viewer"
    });
    seedRbac(repository);
    repository.assignRole(viewer.id, "viewer");
    repository.close();

    const viewerLogin = await login(baseUrl, viewer.email, "password-123");
    const viewerHeaders = { authorization: `Bearer ${viewerLogin.token}` };
    assert.equal((await request(baseUrl, "/api/tasks", { headers: viewerHeaders })).response.status, 200);
    assert.equal(
      (await request(baseUrl, "/api/tasks", {
        method: "POST",
        headers: viewerHeaders,
        body: JSON.stringify({ title: "Viewer should fail" })
      })).response.status,
      403
    );

    const operatorLogin = await login(baseUrl, viewerEmail, "password-123");
    const operatorHeaders = { authorization: `Bearer ${operatorLogin.token}` };
    assert.equal(
      (await request(baseUrl, "/api/tasks", {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ title: "Operator task" })
      })).response.status,
      201
    );
    const chatResult = await request(baseUrl, "/api/chat", {
        method: "POST",
        headers: operatorHeaders,
        body: JSON.stringify({ message: "plan next step" })
      });
    assert.equal(chatResult.response.status, 200);
    assert.equal(chatResult.body.intent, "plan_work");
    assert.equal(chatResult.body.task_suggestions[0].target_agent, "ceo-agent");
    assert.equal(
      (await request(baseUrl, "/api/action-log", { headers: operatorHeaders })).response.status,
      403
    );
  } finally {
    child.kill();
  }
}

async function main() {
  testAgentRegistry();
  testCommandRouting();
  testRiskPolicy();
  await testCeoCreatesCodingBuildTask();
  await testChatEscalatesActionRequests();
  await testAutomaticExecutionClassificationAndQuickQuery();
  await testRoutingNarrationNeverAppears();
  await testFailedQuickQueryReturnsConciseError();
  await testResearchRequestQueuesWorkflow();
  testRuntimeModes();
  testDatabaseRepository();
  testPostgresRepositoryInterface();
  await testFileStorageProviders();
  await testExecutionWorkspaceTools();
  await testDynamicCodingGeneration();
  await testCodingAgentSelfFixLoop();
  await testCodingAgentRetryLimitEnforced();
  testWorkflowEngine();
  await testWorkflowCodingApprovalResume();
  await testAsyncWorkflowBackgroundExecution();
  await testWorkflowConcurrencyAndTimeout();
  await testResearchWorkflowCompletes();
  await testContentEngineWorkflowCompletes();
  await testVoiceVideoPipelineCompletes();
  await testGithubDeploymentToolsAndWorkflow();
  await testBrowserAutomationLayer();
  await testBrowserWorkflowCompletes();
  await testAiProviders();
  await testAgentOrchestrator();
  await testChatAgentUsesLlmProvider();
  await testChatStatusUsesSystemSnapshot();
  await testTaskSpecificStatusSearch();
  await testStatusReportDedupesRepeatedChatTasks();
  await testRbacHttpFlow();

  console.log("Backend tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
