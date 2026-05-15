const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { loadEnvFile } = require("./utils/env");
const { createDatabaseRepository } = require("../../../packages/db/client");
const { agentRegistry } = require("../../agent-runtime/src/agents/registry");
const { handleCommandWithAi } = require("../../agent-runtime/src/agents/ceo-agent");
const { buildStatusReportForMessage, classifyExecutionRequest, createChatAgent, searchTasks } = require("../../agent-runtime/src/agents/chat-agent");
const { createAgentOrchestrator } = require("../../agent-runtime/src/agents/orchestrator");
const contentAgent = require("../../agent-runtime/src/agents/content-agent");
const codingAgent = require("../../agent-runtime/src/agents/coding-agent");
const testingAgent = require("../../agent-runtime/src/agents/testing-agent");
const tradingAgent = require("../../agent-runtime/src/agents/trading-agent");
const { permissionModes } = require("../../agent-runtime/src/permissions/modes");
const { createApprovalQueue } = require("../../agent-runtime/src/approvals/queue");
const { getRuntimeConfig } = require("../../agent-runtime/src/config/runtime");
const { createLlmProvider } = require("../../agent-runtime/src/llm/provider");
const { createToolRegistry } = require("../../agent-runtime/src/tools/tool-registry");
const { createIntelligenceLayer } = require("../../agent-runtime/src/intelligence/memory");
const { createProjectChatWorkspace, createTaskWorkspace, listWorkspaceFiles, listWorkspaceLogs } = require("../../agent-runtime/src/workspace/execution-workspace");
const { createWorkflowEngine } = require("../../agent-runtime/src/workflows/workflow-engine");
const { createStorageService } = require("../../file-service/src/storage");
const { hasPermission, seedRbac } = require("./rbac");
const {
  authRequired,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  readSessionToken,
  safeUser,
  sessionCookie,
  verifyPassword
} = require("./auth");
const { readJsonBody, sendBuffer, sendJson, sendStaticFile, notFound } = require("./utils/http");

loadEnvFile();

const host = process.env.TERMINALX_HOST || "127.0.0.1";
const port = Number(process.env.TERMINALX_PORT || 8787);
const publicRoot = path.resolve(__dirname, "../../../apps/dashboard/public");

const database = createDatabaseRepository();
const shouldSeedCatalog =
  process.env.TERMINALX_AUTO_SEED === "true" ||
  (!process.env.VERCEL && process.env.TERMINALX_AUTO_SEED !== "false");

if (shouldSeedCatalog) {
  database.seedAgents(agentRegistry);
  database.seedPermissions(permissionModes);
  seedRbac(database);
  database.seedSettings({
    runtime_mode: process.env.TERMINALX_RUNTIME_MODE || "ONLINE_MODE",
    database_provider: database.config.provider,
    storage_provider: process.env.FILE_STORAGE_PROVIDER || process.env.STORAGE_PROVIDER || "local"
  });
}

if ((process.env.TERMINALX_ENV || "development") !== "production" || (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD)) {
  const adminUser = database.upsertUser({
    email: process.env.ADMIN_EMAIL || "admin@terminalx.local",
    passwordHash: hashPassword(process.env.ADMIN_PASSWORD || "change-me-now"),
    displayName: "TerminalX Admin",
    role: "admin"
  });
  database.assignRole(adminUser.id, "admin");
}

const approvalQueue = createApprovalQueue(database);
const storageService = createStorageService({
  fileRepository: database,
  approvalQueue,
  appendTaskHistory
});
const llmProvider = createLlmProvider();
const intelligenceLayer = createIntelligenceLayer({ repository: database });
const workflowEngine = createWorkflowEngine({
  repository: database,
  approvalQueue,
  appendTaskHistory,
  createTask,
  executeCodingTask: codingAgent.executeAssignedTask,
  toolRegistryFactory: taskToolRegistry,
  intelligenceLayer,
  workflowTimeoutMs: Number(process.env.WORKFLOW_TIMEOUT_MS || 30000),
  maxConcurrentWorkflows: Number(process.env.WORKFLOW_MAX_CONCURRENT || 1)
});
let workflowPumpRunning = false;
async function pumpWorkflowWorker() {
  if (workflowPumpRunning) return;
  workflowPumpRunning = true;
  try {
    await workflowEngine.runBackgroundOnce();
  } catch (error) {
    database.logAction?.("workflow.worker_error", { message: error.message }, "workflow-engine");
  } finally {
    workflowPumpRunning = false;
  }
}
const workflowWorkerInterval = setInterval(pumpWorkflowWorker, Number(process.env.WORKFLOW_POLL_MS || 1000));
workflowWorkerInterval.unref?.();
function taskToolRegistry(taskId, agentId = "coding-agent") {
  return createToolRegistry({
    taskId,
    agentId,
    approvalQueue,
    logAction: database.logAction?.bind(database),
    appendTaskHistory: database.appendTaskHistory?.bind(database),
    llmProvider,
    searchProvider: process.env.TERMINALX_TEST_WEB_SEARCH_FIXTURE === "true"
      ? async (query, limit) => Array.from({ length: limit }, (_unused, index) => ({
          url: `https://example.com/test-source-${index + 1}`,
          title: `${query} test source ${index + 1}`,
          snippet: `Test source for ${query}`
        }))
      : undefined,
    fetchPage: process.env.TERMINALX_TEST_WEB_SEARCH_FIXTURE === "true"
      ? async (url) => `<html><title>${url}</title><body><p>Test research content for ${url}.</p></body></html>`
      : undefined
  });
}

function formatQuickQueryAnswer(message, summary, sources = []) {
  const cleanSummary = String(summary?.summary || "").replace(/^# Research Summary\s*/i, "").trim();
  const sourceLines = sources.slice(0, 3).map((source) => `- ${source.title || source.url}: ${source.url}`);
  return [
    cleanSummary || `No usable research summary was produced for: ${message}`,
    sourceLines.length ? "" : null,
    sourceLines.length ? "Sources:" : null,
    ...sourceLines
  ].filter(Boolean).join("\n");
}

async function executeQuickQuery({ message, memoryContext = null }) {
  const registry = createToolRegistry({
    agentId: "research-agent",
    logAction: database.logAction?.bind(database),
    llmProvider
  });

  try {
    const search = await registry.execute("web-search", { query: message, limit: 3 });
    const documents = [];
    for (const source of search.results || []) {
      const fetched = await registry.execute("page-fetch", { url: source.url, retries: 1 });
      if (fetched.status === "failed") continue;
      const extracted = await registry.execute("text-extract", {
        url: fetched.url,
        title: fetched.title || source.title,
        html: fetched.html
      });
      documents.push({
        url: extracted.url,
        title: extracted.title,
        text: extracted.text
      });
    }
    const summary = await registry.execute("summarize-content", { query: message, documents });
    intelligenceLayer.remember("research", message, {
      status: "completed",
      summary: summary.summary,
      sources: search.results || [],
      refreshed_at: new Date().toISOString(),
      used_memory: memoryContext?.summary || ""
    });
    return {
      status: "completed",
      response: formatQuickQueryAnswer(message, summary, search.results || []),
      sources: search.results || []
    };
  } catch (error) {
    return {
      status: "failed",
      response: `Execution error: ${error.message}`,
      sources: []
    };
  }
}

function workflowTemplateForExecution(command, executionClass) {
  const normalized = String(command || "").toLowerCase();
  if (executionClass === "deployment_task") return "deploy-app";
  if (executionClass === "browser_task") return "browser-workflow";
  if (/\bfaceless video|youtube video\b/i.test(normalized)) return "faceless-youtube-video";
  if (/\bblog\b/i.test(normalized)) return "blog-article";
  if (/\btwitter|thread\b/i.test(normalized)) return "twitter-thread";
  if (/\binstagram|reel\b/i.test(normalized)) return "instagram-reel-plan";
  if (executionClass === "research_task") return "research-workflow";
  if (/\bapp|api|website|saas|code|build|implement\b/i.test(normalized)) return "app-builder";
  return "ai-news-summary";
}

function startAutonomousWorkflow({ command, executionClass, conversationId = null }) {
  const resolvedClass = executionClass || classifyExecutionRequest(command);
  const executionContext = intelligenceLayer.buildExecutionContext(command);
  const projectWorkspace = createProjectChatWorkspace(conversationId || `project-${Date.now()}`, command);
  const workflow = workflowEngine.createWorkflow({
    template_id: workflowTemplateForExecution(command, resolvedClass),
    name: String(command || "TerminalX workflow").slice(0, 80),
    goal: command,
    context: {
      topic: command,
      command,
      memory_context: executionContext.memory,
      avoid_repeated_failure: executionContext.avoid_repeated_failure,
      avoid_failure_summary: executionContext.avoid_failure_summary,
      decomposed_goal: executionContext.decomposed_goal,
      project_workspace: projectWorkspace.relativeRoot,
      project_memory: "TERMINALX.md",
      linked_files: projectWorkspace.linkedFiles,
      linked_outputs: projectWorkspace.linkedOutputs
    }
  });
  const started = workflowEngine.startWorkflow(workflow.id);
  pumpWorkflowWorker();
  return {
    selected_agent: agentRegistry.find((agent) => agent.type === "ceo"),
    status: "queued",
    response: "Workflow running in background.",
    approval_required: false,
    workflow_id: workflow.id,
    workflow: started.workflow,
    job: started.job,
    execution_class: resolvedClass
  };
}

let agentOrchestrator;
const chatAgent = createChatAgent({
  conversationRepository: database,
  storageService,
  findTask,
  llmProvider,
  executeQuickQuery,
  getMemoryContext: (message) => intelligenceLayer.summarize(message),
  getSystemStatus: () => ({
    agents: agentRegistry,
    tasks: database.listTasks(),
    approvals: approvalQueue.list({ status: "pending" }),
    files: database.listFiles ? database.listFiles() : []
  }),
  orchestrateAction: ({ command, executionMode, executionClass, conversationId }) => {
    if (executionMode !== "plan") {
      return startAutonomousWorkflow({ command, executionClass, conversationId });
    }
    return handleCommandWithAi({
      command,
      createTask,
      approvalQueue,
      llmProvider: null,
      orchestrator: agentOrchestrator,
      executionMode
    });
  }
});
agentOrchestrator = createAgentOrchestrator({
  repository: database,
  approvalQueue,
  chatAgent,
  workspaceRoot: process.env.TERMINALX_WORKSPACE_ROOT || process.cwd()
});

function createTask(payload) {
  return database.createTask(payload);
}

function findTask(taskId) {
  return database.findTask(taskId);
}

function appendTaskHistory(taskId, eventType, payload) {
  if (!taskId) {
    return null;
  }

  return database.appendTaskHistory(taskId, eventType, payload);
}

function systemSnapshot() {
  return {
    agents: agentRegistry,
    tasks: database.listTasks(),
    approvals: approvalQueue.list({ status: "pending" }),
    files: database.listFiles ? database.listFiles() : []
  };
}

async function resumeApprovedWorkflow(approval, decidedBy = "user") {
  if (!approval || approval.status !== "approved" || approval.approvalType !== "repo_modification" || !approval.taskId) {
    return null;
  }

  const task = database.findTask(approval.taskId);
  if (!task) {
    return null;
  }

  database.appendTaskHistory(task.id, "approval.received", {
    approval_id: approval.id,
    decided_by: decidedBy,
    message: "Approval received"
  });
  database.updateTaskStatus(task.id, "running", {
    approval_id: approval.id,
    next_action: "Coding Agent is creating approved files.",
    workspace: createTaskWorkspace(task).relativeRoot
  });
  database.appendTaskHistory(task.id, "coding.creating_files", {
    message: "Creating files",
    proposed_files: approval.proposedAction?.proposedFiles || []
  });

  try {
    const result = await codingAgent.completeApprovedTask({
      task: database.findTask(task.id),
      approval,
      toolRegistry: taskToolRegistry(task.id, "coding-agent"),
      storeFile: (filePayload) => storageService.upload(filePayload)
    });
    database.appendTaskHistory(task.id, "coding.files_created", {
      message: "Files created",
      files: result.files,
      generated_directory: result.generated_directory
    });
    database.appendTaskHistory(task.id, result.test_result?.status === "passed" ? "testing.passed" : "testing.failed", {
      message: "Running tests",
      result: result.test_result
    });
    database.appendTaskHistory(task.id, result.status === "completed" ? "task.completed" : "task.failed", result);
    database.updateTaskStatus(task.id, result.status, {
      latest_output: result.response,
      workspace: result.workspace,
      generated_directory: result.generated_directory,
      generated_files: result.files,
      test_result: result.test_result,
      next_action: result.status === "completed" ? "Open the Files page to review generated files." : "Review execution logs and ask Coding Agent to fix the failure."
    });
    const resumedWorkflow = workflowEngine.resumeCodingTask(task, result);
    if (resumedWorkflow && !["completed", "failed", "waiting_approval"].includes(resumedWorkflow.status)) {
      workflowEngine.tickWorker();
    }
    return result;
  } catch (error) {
    database.appendTaskHistory(task.id, "coding.failed", {
      message: error.message
    });
    database.updateTaskStatus(task.id, "failed", {
      error: error.message,
      next_action: "Ask CEO Agent to inspect the failure and retry safely."
    });
    return {
      status: "failed",
      error: error.message
    };
  }
}

function isProtectedPath(url) {
  return [
    "/api/tasks",
    "/api/approvals",
    "/api/files",
    "/api/workspaces",
    "/api/workflows",
    "/api/bots",
    "/api/integrations",
    "/api/command",
    "/api/chat",
    "/api/action-log"
  ].some((pathPrefix) => url.pathname === pathPrefix || url.pathname.startsWith(`${pathPrefix}/`));
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
}

function currentSession(req) {
  const token = readSessionToken(req);
  if (!token) {
    return null;
  }
  const tokenHash = hashSessionToken(token);
  const session = database.findSessionByTokenHash(tokenHash);
  if (!session) {
    return null;
  }
  const user = database.findUserById(session.userId);
  if (user) {
    user.roles = database.listUserRoles(user.id);
    user.permissions = database.listUserPermissions(user.id);
  }
  return user ? { token, tokenHash, session, user } : null;
}

function requireAuth(req, res, url) {
  if (!authRequired() || !isProtectedPath(url)) {
    return true;
  }
  const session = currentSession(req);
  if (session) {
    req.currentUser = session.user;
    req.currentSession = session;
    return true;
  }
  sendJson(res, 401, { error: "unauthorized", message: "Login required." });
  return false;
}

function requirePermission(req, res, permissionName) {
  if (!authRequired()) {
    return true;
  }
  if (hasPermission(req.currentUser?.permissions, permissionName)) {
    return true;
  }
  sendJson(res, 403, { error: "forbidden", permission: permissionName });
  return false;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      name: process.env.TERMINALX_APP_NAME || "TerminalX",
      environment: process.env.TERMINALX_ENV || "development",
      runtimeMode: getRuntimeConfig().mode,
      timestamp: new Date().toISOString()
    });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/register") {
    const payload = await readJsonBody(req);
    const email = String(payload.email || "").trim().toLowerCase();
    const password = String(payload.password || "");
    if (!email || password.length < 8) {
      return sendJson(res, 400, { error: "invalid_auth_request", message: "Email and an 8+ character password are required." });
    }
    if (database.findUserByEmail(email)) {
      return sendJson(res, 409, { error: "user_exists" });
    }
    const user = database.createUser({
      email,
      passwordHash: hashPassword(password),
      displayName: payload.display_name || payload.displayName || "",
      role: "operator"
    });
    database.assignRole(user.id, "operator");
    user.roles = database.listUserRoles(user.id);
    user.permissions = database.listUserPermissions(user.id);
    database.logLoginAudit({
      userId: user.id,
      email,
      action: "register",
      success: true,
      ipAddress: requestIp(req),
      userAgent: req.headers["user-agent"] || ""
    });
    return sendJson(res, 201, { user: safeUser(user) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const payload = await readJsonBody(req);
    const email = String(payload.email || "").trim().toLowerCase();
    const user = database.findUserByEmail(email);
    const ok = Boolean(user && verifyPassword(payload.password, user.passwordHash));
    database.logLoginAudit({
      userId: user?.id || null,
      email,
      action: "login",
      success: ok,
      ipAddress: requestIp(req),
      userAgent: req.headers["user-agent"] || ""
    });
    if (!ok) {
      return sendJson(res, 401, { error: "invalid_credentials" });
    }
    user.roles = database.listUserRoles(user.id);
    user.permissions = database.listUserPermissions(user.id);
    const token = createSessionToken();
    database.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
    });
    return sendJson(res, 200, { user: safeUser(user) }, { "set-cookie": sessionCookie(token) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = currentSession(req);
    if (session) {
      database.revokeSession(session.tokenHash);
      database.logLoginAudit({
        userId: session.user.id,
        email: session.user.email,
        action: "logout",
        success: true,
        ipAddress: requestIp(req),
        userAgent: req.headers["user-agent"] || ""
      });
    }
    return sendJson(res, 200, { ok: true }, { "set-cookie": clearSessionCookie() });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const session = currentSession(req);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      user: safeUser(session?.user)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/permissions") {
    const session = currentSession(req);
    return sendJson(res, 200, {
      authenticated: Boolean(session),
      roles: session?.user.roles || [],
      permissions: session?.user.permissions || []
    });
  }

  if (!requireAuth(req, res, url)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agents") {
    return sendJson(res, 200, { agents: agentRegistry });
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    if (authRequired() && !hasPermission(req.currentUser?.permissions, "settings:manage")) {
      return sendJson(res, 200, { permissionModes: [] });
    }
    return sendJson(res, 200, { permissionModes });
  }

  if (req.method === "GET" && url.pathname === "/api/workflows/templates") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { templates: workflowEngine.templates() });
  }

  if (req.method === "GET" && url.pathname === "/api/workflows/worker") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, {
      jobs: workflowEngine.listJobs(),
      heartbeat: {
        status: "online",
        checkedAt: new Date().toISOString()
      }
    });
  }

  if (req.method === "POST" && url.pathname === "/api/workflows/worker/tick") {
    if (!requirePermission(req, res, "agents:execute")) return;
    return sendJson(res, 200, await workflowEngine.tickWorkerAsync());
  }

  if (req.method === "GET" && url.pathname === "/api/workflows") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { workflows: workflowEngine.listWorkflows() });
  }

  if (req.method === "POST" && url.pathname === "/api/workflows") {
    if (!requirePermission(req, res, "tasks:create")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 201, { workflow: workflowEngine.createWorkflow(payload) });
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/workflows\/[^/]+\/run$/)) {
    if (!requirePermission(req, res, "agents:execute")) return;
    const workflowId = url.pathname.split("/")[3];
    const started = workflowEngine.startWorkflow(workflowId);
    pumpWorkflowWorker();
    return sendJson(res, 202, {
      ...started,
      status: "queued",
      message: "Workflow queued. Background worker will continue execution."
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bots") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { bots: workflowEngine.listBots() });
  }

  if (req.method === "POST" && url.pathname === "/api/bots") {
    if (!requirePermission(req, res, "tasks:create")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 201, { bot: workflowEngine.createBot(payload) });
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/bots\/[^/]+\/memory$/)) {
    if (!requirePermission(req, res, "tasks:read")) return;
    const botId = url.pathname.split("/")[3];
    return sendJson(res, 200, { memory: workflowEngine.getBotMemory(botId) });
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/bots\/[^/]+\/memory$/)) {
    if (!requirePermission(req, res, "tasks:update")) return;
    const botId = url.pathname.split("/")[3];
    const payload = await readJsonBody(req);
    return sendJson(res, 200, { memory: workflowEngine.saveBotMemory(botId, payload) });
  }

  if (req.method === "GET" && url.pathname === "/api/integrations") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { integrations: workflowEngine.integrations() });
  }

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { tasks: database.listTasks() });
  }

  if (req.method === "GET" && url.pathname === "/api/tasks/search") {
    if (!requirePermission(req, res, "tasks:read")) return;
    const query = url.searchParams.get("q") || "";
    const matches = searchTasks(database.listTasks(), query).map((entry) => ({
      ...entry.task,
      matchScore: entry.score
    }));
    return sendJson(res, 200, { query, tasks: matches });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    if (!requirePermission(req, res, "tasks:create")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 201, { task: createTask(payload) });
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/workspaces\/[^/]+$/)) {
    if (!requirePermission(req, res, "tasks:read")) return;
    const taskId = url.pathname.split("/")[3];
    const task = database.findTask(taskId);
    if (!task) return notFound(res);
    const workspace = createTaskWorkspace(task);
    return sendJson(res, 200, {
      task_id: taskId,
      workspace: {
        path: workspace.relativeRoot,
        files_path: `${workspace.relativeRoot}/files`,
        logs_path: `${workspace.relativeRoot}/logs`,
        outputs_path: `${workspace.relativeRoot}/outputs`
      }
    });
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/workspaces\/[^/]+\/files$/)) {
    if (!requirePermission(req, res, "files:read")) return;
    const taskId = url.pathname.split("/")[3];
    return database.findTask(taskId) ? sendJson(res, 200, { files: listWorkspaceFiles(taskId) }) : notFound(res);
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/workspaces\/[^/]+\/logs$/)) {
    if (!requirePermission(req, res, "tasks:read")) return;
    const taskId = url.pathname.split("/")[3];
    return database.findTask(taskId) ? sendJson(res, 200, { logs: listWorkspaceLogs(taskId) }) : notFound(res);
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/tasks\/[^/]+\/run$/)) {
    if (!requirePermission(req, res, "agents:execute")) return;
    const taskId = url.pathname.split("/")[3];
    const task = database.findTask(taskId);
    if (!task) return notFound(res);
    const agent = agentRegistry.find((entry) => entry.id === task.assignedAgentId) || agentRegistry.find((entry) => entry.type === "coding");
    const result = await agentOrchestrator.execute({
      taskId,
      agent,
      command: task.description || task.title
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/tasks\/[^/]+\/resume$/)) {
    if (!requirePermission(req, res, "agents:execute")) return;
    const taskId = url.pathname.split("/")[3];
    const approval = approvalQueue.list({ status: "approved" }).find((entry) => entry.taskId === taskId);
    if (!approval) {
      return sendJson(res, 409, { error: "approval_required", message: "Approve the pending action before resuming this task." });
    }
    return sendJson(res, 200, { resumed: await resumeApprovedWorkflow(approval, req.currentUser?.email || "user") });
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    if (!requirePermission(req, res, "agents:execute")) return;
    const payload = await readJsonBody(req);
    const statusReport = buildStatusReportForMessage(payload.command, systemSnapshot());
    if (statusReport) {
      return sendJson(res, 200, {
        selected_agent: agentRegistry.find((agent) => agent.type === "ceo"),
        task_id: statusReport.task?.id || null,
        status: "status_report",
        response: statusReport.response,
        approval_required: false,
        status_report: statusReport,
        task_status: statusReport.kind === "task_status" ? statusReport.task : null
      });
    }
    const executionClass = classifyExecutionRequest(payload.command);
    if (executionClass === "quick_query") {
      const quickResult = await executeQuickQuery({ message: payload.command });
      return sendJson(res, 200, {
        selected_agent: agentRegistry.find((agent) => agent.type === "ceo"),
        task_id: null,
        status: quickResult.status,
        response: quickResult.response,
        approval_required: false,
        execution_class: executionClass,
        sources: quickResult.sources
      });
    }
    if (executionClass !== "none" && (payload.execution_mode || payload.executionMode || "execution") !== "plan") {
      return sendJson(res, 202, startAutonomousWorkflow({ command: payload.command, executionClass, conversationId: payload.conversation_id || payload.conversationId }));
    }
    const result = await handleCommandWithAi({
      command: payload.command,
      createTask,
      approvalQueue,
      llmProvider: payload.fast === true ? null : llmProvider,
      orchestrator: agentOrchestrator,
      executionMode: payload.execution_mode || payload.executionMode || "execution"
    });
    return sendJson(res, 201, result);
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    if (!requirePermission(req, res, "chat:use")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 200, await chatAgent.respond(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/content") {
    const payload = await readJsonBody(req);
    let result;
    try {
      result = contentAgent.runContentAction(payload, approvalQueue);
    } catch (error) {
      return sendJson(res, 400, {
        error: "content_request_rejected",
        message: error.message
      });
    }
    if (payload.task_id) {
      appendTaskHistory(payload.task_id, "content.generated", result);
    }
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/trading/analyze") {
    const payload = await readJsonBody(req);
    let result;
    try {
      result = tradingAgent.runTradingAction(payload);
    } catch (error) {
      return sendJson(res, 400, {
        error: "trading_request_rejected",
        message: error.message,
        mode: "analysis_only",
        broker_connected: false
      });
    }
    if (payload.task_id) {
      appendTaskHistory(payload.task_id, "trading.analysis", result);
    }
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/chat/history") {
    if (!requirePermission(req, res, "chat:use")) return;
    return sendJson(res, 200, {
      history: chatAgent.history(url.searchParams.get("conversation_id") || undefined)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/approvals") {
    if (!requirePermission(req, res, "approvals:read")) return;
    return sendJson(res, 200, {
      approvals: approvalQueue.list({
        status: url.searchParams.get("status") || undefined
      })
    });
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/approvals\/[^/]+\/approve$/)) {
    if (!requirePermission(req, res, "approvals:approve")) return;
    const approvalId = url.pathname.split("/")[3];
    const payload = await readJsonBody(req);
    const decidedBy = req.currentUser?.email || payload.decidedBy || "user";
    const approval = approvalQueue.decide(approvalId, "approved", decidedBy);
    if (!approval) return notFound(res);
    let resumed = await resumeApprovedWorkflow(approval, decidedBy);
    if (!resumed && approval.proposedAction?.workflow_id) {
      resumed = workflowEngine.resumeApproval(approval);
      if (resumed) {
        resumed = await workflowEngine.tickWorkerAsync();
      }
    }
    return sendJson(res, 200, { approval, resumed });
  }

  if (req.method === "POST" && url.pathname.match(/^\/api\/approvals\/[^/]+\/reject$/)) {
    if (!requirePermission(req, res, "approvals:approve")) return;
    const approvalId = url.pathname.split("/")[3];
    const payload = await readJsonBody(req);
    const approval = approvalQueue.decide(approvalId, "rejected", payload.decidedBy || "user");
    return approval ? sendJson(res, 200, { approval }) : notFound(res);
  }

  if (req.method === "GET" && url.pathname === "/api/action-log") {
    if (!requirePermission(req, res, "settings:manage")) return;
    return sendJson(res, 200, { actions: approvalQueue.logs() });
  }

  if (req.method === "POST" && url.pathname === "/api/coding/read-file") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, codingAgent.readFile(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/coding/suggest-change") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, codingAgent.suggestChange(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/coding/create-file") {
    const payload = await readJsonBody(req);
    return sendJson(res, 201, codingAgent.createFile(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/coding/modify-file") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, codingAgent.modifyFile(payload, approvalQueue));
  }

  if (req.method === "POST" && url.pathname === "/api/coding/delete-file") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, codingAgent.deleteFile(payload, approvalQueue));
  }

  if (req.method === "POST" && url.pathname === "/api/coding/run-command") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, await codingAgent.executeCommand(payload, approvalQueue));
  }

  if (req.method === "POST" && url.pathname === "/api/test/run") {
    const payload = await readJsonBody(req);
    const result = await testingAgent.runTests(payload, {
      approvalQueue,
      appendTaskHistory,
      createTask
    });
    return sendJson(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/coding/github") {
    return sendJson(res, 200, codingAgent.githubStatus());
  }

  if (req.method === "GET" && url.pathname === "/api/files") {
    if (!requirePermission(req, res, "files:read")) return;
    return sendJson(res, 200, {
      files: storageService.list({
        task_id: url.searchParams.get("task_id") || undefined
      })
    });
  }

  if (req.method === "POST" && url.pathname === "/api/files/upload") {
    if (!requirePermission(req, res, "files:upload")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 201, { file: await storageService.upload(payload) });
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/files\/[^/]+$/)) {
    if (!requirePermission(req, res, "files:read")) return;
    const fileId = url.pathname.split("/")[3];
    const file = storageService.get(fileId);
    return file ? sendJson(res, 200, { file }) : notFound(res);
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/files\/[^/]+\/read$/)) {
    if (!requirePermission(req, res, "files:read")) return;
    const fileId = url.pathname.split("/")[3];
    const fileContent = await storageService.read(fileId);
    return fileContent ? sendJson(res, 200, fileContent) : notFound(res);
  }

  if (req.method === "GET" && url.pathname.match(/^\/api\/files\/[^/]+\/download$/)) {
    if (!requirePermission(req, res, "files:read")) return;
    const fileId = url.pathname.split("/")[3];
    const download = await storageService.download(fileId);
    return download
      ? sendBuffer(res, 200, download.content, {
          filename: download.file.filename,
          contentType: download.file.mime_type
        })
      : notFound(res);
  }

  if (req.method === "DELETE" && url.pathname.match(/^\/api\/files\/[^/]+$/)) {
    if (!requirePermission(req, res, "files:delete")) return;
    const fileId = url.pathname.split("/")[3];
    const result = await storageService.remove({
      fileId,
      approvalId: url.searchParams.get("approval_id")
    });
    return result ? sendJson(res, 200, result) : notFound(res);
  }

  if (req.method === "GET" && url.pathname === "/api/config/storage") {
    const config = storageService.config();
    return sendJson(res, 200, {
      storage: {
        mode: config.mode,
        provider: config.provider,
        localPath: config.localPath,
        supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseBucket),
        s3Configured: Boolean(config.s3Endpoint && config.s3Bucket),
        bucket: config.supabaseBucket || config.s3Bucket || "local"
      }
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config/runtime") {
    const runtime = getRuntimeConfig();
    return sendJson(res, 200, {
      runtime,
      llmProvider: llmProvider.describe()
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config/database") {
    return sendJson(res, 200, { database: database.config });
  }

  return notFound(res);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }

    if (url.pathname === "/" || url.pathname === "/dashboard") {
      return sendStaticFile(res, path.join(publicRoot, "index.html"));
    }

    return sendStaticFile(res, path.join(publicRoot, url.pathname));
  } catch (error) {
    return sendJson(res, 500, {
      error: "internal_server_error",
      message: error.message
    });
  }
}

function startServer() {
  const server = http.createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`TerminalX MVP server listening at http://${host}:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  handleApi,
  handleRequest,
  startServer
};
