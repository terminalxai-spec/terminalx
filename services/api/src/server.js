const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { loadEnvFile } = require("./utils/env");
const { createDatabaseRepository } = require("../../../packages/db/client");
const { agentRegistry } = require("../../agent-runtime/src/agents/registry");
const { handleCommandWithAi } = require("../../agent-runtime/src/agents/ceo-agent");
const { createChatAgent } = require("../../agent-runtime/src/agents/chat-agent");
const { createAgentOrchestrator } = require("../../agent-runtime/src/agents/orchestrator");
const contentAgent = require("../../agent-runtime/src/agents/content-agent");
const codingAgent = require("../../agent-runtime/src/agents/coding-agent");
const testingAgent = require("../../agent-runtime/src/agents/testing-agent");
const tradingAgent = require("../../agent-runtime/src/agents/trading-agent");
const { permissionModes } = require("../../agent-runtime/src/permissions/modes");
const { createApprovalQueue } = require("../../agent-runtime/src/approvals/queue");
const { getRuntimeConfig } = require("../../agent-runtime/src/config/runtime");
const { createLlmProvider } = require("../../agent-runtime/src/llm/provider");
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
let agentOrchestrator;
const chatAgent = createChatAgent({
  conversationRepository: database,
  storageService,
  findTask,
  llmProvider,
  getSystemStatus: () => ({
    agents: agentRegistry,
    tasks: database.listTasks(),
    approvals: approvalQueue.list({ status: "pending" })
  }),
  orchestrateAction: ({ command, executionMode }) =>
    handleCommandWithAi({
      command,
      createTask,
      approvalQueue,
      llmProvider: null,
      orchestrator: agentOrchestrator,
      executionMode
    })
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

function isProtectedPath(url) {
  return [
    "/api/tasks",
    "/api/approvals",
    "/api/files",
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

  if (req.method === "GET" && url.pathname === "/api/tasks") {
    if (!requirePermission(req, res, "tasks:read")) return;
    return sendJson(res, 200, { tasks: database.listTasks() });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    if (!requirePermission(req, res, "tasks:create")) return;
    const payload = await readJsonBody(req);
    return sendJson(res, 201, { task: createTask(payload) });
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    if (!requirePermission(req, res, "agents:execute")) return;
    const payload = await readJsonBody(req);
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
    const approval = approvalQueue.decide(approvalId, "approved", payload.decidedBy || "user");
    return approval ? sendJson(res, 200, { approval }) : notFound(res);
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
