const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { classifyIntent, evaluateRisk, handleCommandWithAi } = require("../services/agent-runtime/src/agents/ceo-agent");
const { createChatAgent } = require("../services/agent-runtime/src/agents/chat-agent");
const { TASK_STATUSES, createAgentOrchestrator } = require("../services/agent-runtime/src/agents/orchestrator");
const { getRuntimeConfig, normalizeRuntimeMode } = require("../services/agent-runtime/src/config/runtime");
const { evaluateCommandPermission } = require("../services/agent-runtime/src/permissions/policy");
const { agentRegistry } = require("../services/agent-runtime/src/agents/registry");
const { createDatabaseRepository, migrateSqlite, PostgresRepository } = require("../packages/db/client");
const { GroqProvider, OllamaProvider, createLlmProvider, parseIntentFromText } = require("../services/agent-runtime/src/llm/provider");
const { createApprovalQueue } = require("../services/agent-runtime/src/approvals/queue");
const { createStorageService } = require("../services/file-service/src/storage");
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
  const result = await handleCommandWithAi({
    command: "create simple calculator",
    createTask: (payload) => repository.createTask(payload),
    approvalQueue,
    llmProvider: {
      async classifyIntent() {
        return { intent: "coding", provider: "test" };
      }
    }
  });

  const task = repository.findTask(result.task_id);
  assert.equal(result.status, "created");
  assert.equal(result.selected_agent.type, "coding");
  assert.equal(result.response, "Task created and assigned to Coding Agent.");
  assert.equal(task.title, "Build Simple Calculator");
  assert.equal(task.assignedAgentId, "coding-agent");
  assert.equal(task.status, "created");
  assert.deepEqual(task.metadata.requirements, [
    "CLI calculator",
    "add/subtract/multiply/divide",
    "input validation",
    "tests"
  ]);
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
    const commandResult = await request(baseUrl, "/api/command", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ command: "help me plan my day" })
    });
    assert.equal(commandResult.response.status, 201);
    assert.equal(commandResult.body.status, "completed");

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
  testRuntimeModes();
  testDatabaseRepository();
  testPostgresRepositoryInterface();
  await testFileStorageProviders();
  await testAiProviders();
  await testAgentOrchestrator();
  await testChatAgentUsesLlmProvider();
  await testRbacHttpFlow();

  console.log("Backend tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
