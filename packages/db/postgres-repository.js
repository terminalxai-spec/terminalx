const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

let idCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function maskConnectionString(value) {
  return value ? value.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@") : null;
}

function asJson(value) {
  return JSON.stringify(value ?? {});
}

function boolValue(value) {
  return value === true || value === 1 || value === "1";
}

function mapTask(row, history = []) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    status: row.status,
    assignedAgentId: row.assigned_agent_id,
    intent: row.intent,
    approvalRequired: Boolean(row.approval_required),
    riskLevel: row.risk_level,
    metadata: parseJson(row.metadata, {}),
    history,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapHistory(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at
  };
}

function mapApproval(row) {
  return {
    id: row.id,
    title: row.title,
    taskId: row.task_id || undefined,
    status: row.status,
    approvalType: row.approval_type,
    riskLevel: row.risk_level,
    requestedBy: row.requested_by,
    assignedAgentId: row.assigned_agent_id || undefined,
    description: row.description || "",
    proposedAction: parseJson(row.proposed_action, {}),
    decidedBy: row.decided_by || undefined,
    decidedAt: row.decided_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapFile(row) {
  return {
    id: row.id,
    task_id: row.task_id || null,
    filename: row.filename,
    storage_provider: row.storage_provider || row.provider,
    storage_key: row.storage_key || row.path,
    path: row.path,
    mime_type: row.mime_type,
    size: row.size || row.size_bytes,
    size_bytes: row.size_bytes,
    mode: row.mode,
    provider: row.provider,
    bucket: row.bucket,
    onlineConfigured: Boolean(row.online_configured),
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapLog(row) {
  return {
    id: row.id,
    agentId: row.agent_id || undefined,
    action: row.action,
    payload: parseJson(row.payload, {}),
    createdAt: row.created_at
  };
}

function mapSetting(row) {
  return {
    id: row.id,
    scope: row.scope,
    key: row.key,
    value: parseJson(row.value, {}),
    isSecret: Boolean(row.is_secret),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

class PostgresRepository {
  constructor({ databaseUrl, query } = {}) {
    if (!databaseUrl && !query) {
      throw new Error("DATABASE_URL is required when DATABASE_PROVIDER=postgres.");
    }

    this.databaseUrl = databaseUrl;
    this.queryImpl = query || this.queryViaWorker.bind(this);
    this.kind = "postgres";
    this.config = {
      connected: true,
      provider: "postgres",
      requestedProvider: "postgres",
      url: maskConnectionString(databaseUrl),
      fallback: false,
      supabaseCompatible: true,
      note: "Using PostgreSQL runtime repository."
    };
  }

  queryViaWorker(sql, params = []) {
    const runnerPath = path.join(__dirname, "pg-runner.js");
    const result = spawnSync(process.execPath, [runnerPath, JSON.stringify({ sql, params })], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: this.databaseUrl },
      windowsHide: true
    });

    if (result.error) {
      throw new Error(`PostgreSQL query failed to start: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const missingPg = /Cannot find module 'pg'/.test(result.stderr || "");
      throw new Error(
        missingPg
          ? "PostgreSQL runtime requires the pg package. Run npm install before DATABASE_PROVIDER=postgres."
          : `PostgreSQL query failed: ${result.stderr || result.stdout}`
      );
    }

    return JSON.parse(result.stdout || "{\"rows\":[]}").rows;
  }

  close() {}

  seedAgents(agents) {
    for (const agent of agents) {
      this.queryImpl(
        `insert into agents (id, name, type, status, default_model, responsibilities, metadata, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, now(), now())
         on conflict(id) do update set
           name = excluded.name,
           type = excluded.type,
           status = excluded.status,
           default_model = excluded.default_model,
           responsibilities = excluded.responsibilities,
           updated_at = now()`,
        [
          agent.id,
          agent.name,
          agent.type,
          agent.status,
          agent.defaultModel,
          asJson(agent.responsibilities || []),
          asJson(agent.metadata || {})
        ]
      );
    }
  }

  seedPermissions(permissionModes) {
    for (const mode of permissionModes) {
      this.queryImpl(
        `insert into permissions (id, label, description, requires_approval, risk_level, policy, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, now(), now())
         on conflict(id) do update set
           label = excluded.label,
           description = excluded.description,
           requires_approval = excluded.requires_approval,
           risk_level = excluded.risk_level,
           policy = excluded.policy,
           updated_at = now()`,
        [mode.id, mode.label, mode.description, Boolean(mode.requiresApproval), mode.riskLevel || "low", asJson(mode)]
      );
    }
  }

  seedSettings(settingsPayload = {}) {
    for (const [key, value] of Object.entries(settingsPayload)) {
      this.setSetting("system", key, value, false);
    }
  }

  createUser({ id = crypto.randomUUID(), email, passwordHash, displayName = "", role = "operator" }) {
    const rows = this.queryImpl(
      `insert into users (id, email, display_name, password_hash, role, created_at, updated_at)
       values ($1, $2, $3, $4, $5, now(), now())
       returning *`,
      [id, String(email || "").toLowerCase(), displayName, passwordHash, role]
    );
    return mapUser(rows[0]);
  }

  upsertUser({ id = crypto.randomUUID(), email, passwordHash, displayName = "", role = "operator" }) {
    const rows = this.queryImpl(
      `insert into users (id, email, display_name, password_hash, role, created_at, updated_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict(email) do update set
         display_name = excluded.display_name,
         password_hash = excluded.password_hash,
         role = excluded.role,
         updated_at = now()
       returning *`,
      [id, String(email || "").toLowerCase(), displayName, passwordHash, role]
    );
    return mapUser(rows[0]);
  }

  findUserByEmail(email) {
    const row = this.queryImpl("select * from users where email = $1", [String(email || "").toLowerCase()])[0];
    return row ? mapUser(row) : null;
  }

  findUserById(id) {
    const row = this.queryImpl("select * from users where id = $1", [id])[0];
    return row ? mapUser(row) : null;
  }

  createSession({ id = createId("session"), userId, tokenHash, expiresAt }) {
    const rows = this.queryImpl(
      "insert into sessions (id, user_id, token_hash, expires_at, created_at) values ($1, $2, $3, $4, now()) returning *",
      [id, userId, tokenHash, expiresAt]
    );
    return {
      id: rows[0].id,
      userId: rows[0].user_id,
      tokenHash: rows[0].token_hash,
      expiresAt: rows[0].expires_at,
      createdAt: rows[0].created_at
    };
  }

  findSessionByTokenHash(tokenHash) {
    const row = this.queryImpl(
      "select * from sessions where token_hash = $1 and revoked_at is null and expires_at > now()",
      [tokenHash]
    )[0];
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          tokenHash: row.token_hash,
          expiresAt: row.expires_at,
          createdAt: row.created_at
        }
      : null;
  }

  revokeSession(tokenHash) {
    this.queryImpl("update sessions set revoked_at = now() where token_hash = $1", [tokenHash]);
    return true;
  }

  logLoginAudit({ userId = null, email = "", action, success = false, ipAddress = "", userAgent = "" }) {
    const rows = this.queryImpl(
      `insert into login_audit_logs (id, user_id, email, action, success, ip_address, user_agent, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       returning *`,
      [createId("login_audit"), userId, email, action, Boolean(success), ipAddress, userAgent]
    );
    return rows[0];
  }

  upsertRole({ id, label, description = "" }) {
    const rows = this.queryImpl(
      `insert into roles (id, label, description, created_at, updated_at)
       values ($1, $2, $3, now(), now())
       on conflict(id) do update set
         label = excluded.label,
         description = excluded.description,
         updated_at = now()
       returning *`,
      [id, label, description]
    );
    return rows[0];
  }

  assignRole(userId, roleId) {
    this.queryImpl(
      `insert into user_roles (user_id, role_id, created_at)
       values ($1, $2, now())
       on conflict(user_id, role_id) do nothing`,
      [userId, roleId]
    );
    return true;
  }

  setRolePermissions(roleId, permissions = []) {
    this.queryImpl("delete from role_permissions where role_id = $1", [roleId]);
    for (const permission of permissions) {
      this.queryImpl(
        `insert into role_permissions (role_id, permission_name, created_at)
         values ($1, $2, now())
         on conflict(role_id, permission_name) do nothing`,
        [roleId, permission]
      );
    }
    return permissions;
  }

  listUserRoles(userId) {
    return this.queryImpl("select role_id from user_roles where user_id = $1 order by role_id asc", [userId]).map(
      (row) => row.role_id
    );
  }

  listUserPermissions(userId) {
    return this.queryImpl(
      `select distinct rp.permission_name
       from user_roles ur
       join role_permissions rp on rp.role_id = ur.role_id
       where ur.user_id = $1
       order by rp.permission_name asc`,
      [userId]
    ).map((row) => row.permission_name);
  }

  createTask(payload) {
    const task = {
      id: payload.id || createId("task"),
      title: payload.title || "Untitled task",
      description: payload.description || "",
      status: payload.status || "created",
      assignedAgentId: payload.assignedAgentId || "ceo-agent",
      intent: payload.intent || null,
      approvalRequired: Boolean(payload.approvalRequired),
      riskLevel: payload.riskLevel || "low",
      metadata: {
        sourceTaskId: payload.sourceTaskId || null,
        testFramework: payload.testFramework || null,
        testCommand: payload.testCommand || null,
        ...(payload.metadata || {})
      },
      history: []
    };
    const rows = this.queryImpl(
      `insert into tasks (id, title, description, status, assigned_agent_id, intent, approval_required, risk_level, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
       returning *`,
      [
        task.id,
        task.title,
        task.description,
        task.status,
        task.assignedAgentId,
        task.intent,
        task.approvalRequired,
        task.riskLevel,
        asJson(task.metadata)
      ]
    );
    return mapTask(rows[0], []);
  }

  taskHistory(taskId) {
    return this.queryImpl("select * from task_history where task_id = $1 order by created_at desc", [taskId]).map(mapHistory);
  }

  listTasks() {
    return this.queryImpl("select * from tasks order by created_at desc").map((row) => mapTask(row, this.taskHistory(row.id)));
  }

  findTask(taskId) {
    const row = this.queryImpl("select * from tasks where id = $1", [taskId])[0];
    return row ? mapTask(row, this.taskHistory(row.id)) : null;
  }

  updateTaskStatus(taskId, status, metadata = {}) {
    const task = this.findTask(taskId);
    if (!task) {
      return null;
    }
    const nextMetadata = {
      ...(task.metadata || {}),
      ...(metadata || {})
    };
    const rows = this.queryImpl(
      `update tasks
       set status = $1, metadata = $2::jsonb, updated_at = now()
       where id = $3
       returning *`,
      [status, asJson(nextMetadata), taskId]
    );
    return rows[0] ? mapTask(rows[0], this.taskHistory(taskId)) : null;
  }

  appendTaskHistory(taskId, eventType, payload) {
    if (!taskId || !this.findTask(taskId)) {
      return null;
    }
    const rows = this.queryImpl(
      `insert into task_history (id, task_id, event_type, payload, created_at)
       values ($1, $2, $3, $4::jsonb, now())
       returning *`,
      [createId("event"), taskId, eventType, asJson(payload)]
    );
    this.queryImpl("update tasks set updated_at = now() where id = $1", [taskId]);
    return mapHistory(rows[0]);
  }

  listApprovals(filter = {}) {
    const rows = filter.status
      ? this.queryImpl("select * from approvals where status = $1 order by created_at desc", [filter.status])
      : this.queryImpl("select * from approvals order by created_at desc");
    return rows.map(mapApproval);
  }

  getApproval(id) {
    const row = this.queryImpl("select * from approvals where id = $1", [id])[0];
    return row ? mapApproval(row) : null;
  }

  addApproval(approval) {
    const storedApproval = {
      ...approval,
      id: approval.id || createId("approval"),
      status: approval.status || "pending",
      approvalType: approval.approvalType || "risky_action",
      riskLevel: approval.riskLevel || "medium",
      requestedBy: approval.requestedBy || "system",
      proposedAction: approval.proposedAction || {}
    };
    const rows = this.queryImpl(
      `insert into approvals (id, task_id, title, status, approval_type, risk_level, requested_by, assigned_agent_id, description, proposed_action, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now(), now())
       on conflict(id) do update set
         status = excluded.status,
         updated_at = now()
       returning *`,
      [
        storedApproval.id,
        storedApproval.taskId || null,
        storedApproval.title,
        storedApproval.status,
        storedApproval.approvalType,
        storedApproval.riskLevel,
        storedApproval.requestedBy,
        storedApproval.assignedAgentId || null,
        storedApproval.description || "",
        asJson(storedApproval.proposedAction)
      ]
    );
    return mapApproval(rows[0]);
  }

  decideApproval(id, status, decidedBy = "user") {
    const rows = this.queryImpl(
      "update approvals set status = $1, decided_by = $2, decided_at = now(), updated_at = now() where id = $3 returning *",
      [status, decidedBy, id]
    );
    return rows[0] ? mapApproval(rows[0]) : null;
  }

  logAction(action, payload = {}, agentId = null) {
    const rows = this.queryImpl(
      "insert into agent_logs (id, agent_id, action, payload, created_at) values ($1, $2, $3, $4::jsonb, now()) returning *",
      [createId("log"), agentId, action, asJson(payload)]
    );
    return mapLog(rows[0]);
  }

  listLogs() {
    return this.queryImpl("select * from agent_logs order by created_at desc").map(mapLog);
  }

  upsertFile(record) {
    const rows = this.queryImpl(
      `insert into files (id, task_id, filename, storage_provider, storage_key, path, mime_type, size, size_bytes, mode, provider, bucket, online_configured, metadata, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, now(), now())
       on conflict(id) do update set
         task_id = excluded.task_id,
         filename = excluded.filename,
         storage_provider = excluded.storage_provider,
         storage_key = excluded.storage_key,
         path = excluded.path,
         mime_type = excluded.mime_type,
         size = excluded.size,
         size_bytes = excluded.size_bytes,
         mode = excluded.mode,
         provider = excluded.provider,
         bucket = excluded.bucket,
         online_configured = excluded.online_configured,
         metadata = excluded.metadata,
         updated_at = now()
       returning *`,
      [
        record.id,
        record.task_id || null,
        record.filename,
        record.storage_provider || record.provider,
        record.storage_key || record.path,
        record.path,
        record.mime_type,
        record.size || record.size_bytes,
        record.size_bytes,
        record.mode || null,
        record.provider,
        record.bucket,
        Boolean(record.onlineConfigured),
        asJson(record.metadata || {})
      ]
    );
    return mapFile(rows[0]);
  }

  listFiles(filter = {}) {
    const rows = filter.task_id
      ? this.queryImpl("select * from files where task_id = $1 order by created_at desc", [filter.task_id])
      : this.queryImpl("select * from files order by created_at desc");
    return rows.map(mapFile);
  }

  getFile(fileId) {
    const row = this.queryImpl("select * from files where id = $1", [fileId])[0];
    return row ? mapFile(row) : null;
  }

  deleteFile(fileId) {
    const rows = this.queryImpl("delete from files where id = $1 returning *", [fileId]);
    return rows[0] ? mapFile(rows[0]) : null;
  }

  appendChatMessage({ conversationId, agentId, role, content, metadata = {} }) {
    const rows = this.queryImpl(
      `insert into chat_history (id, conversation_id, agent_id, role, content, metadata, created_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, now())
       returning *`,
      [createId("msg"), conversationId, agentId, role, content, asJson(metadata)]
    );
    const row = rows[0];
    return {
      id: row.id,
      conversationId: row.conversation_id,
      agentId: row.agent_id,
      role: row.role,
      content: row.content,
      metadata: parseJson(row.metadata, {}),
      createdAt: row.created_at
    };
  }

  listConversations(conversationId) {
    const rows = conversationId
      ? this.queryImpl("select * from chat_history where conversation_id = $1 order by created_at asc", [conversationId])
      : this.queryImpl("select * from chat_history order by conversation_id asc, created_at asc");
    const conversations = new Map();
    for (const row of rows) {
      if (!conversations.has(row.conversation_id)) {
        conversations.set(row.conversation_id, {
          id: row.conversation_id,
          agentId: row.agent_id,
          messages: [],
          createdAt: row.created_at,
          updatedAt: row.created_at
        });
      }
      const conversation = conversations.get(row.conversation_id);
      conversation.messages.push({
        id: row.id,
        role: row.role,
        content: row.content,
        metadata: parseJson(row.metadata, {}),
        createdAt: row.created_at
      });
      conversation.updatedAt = row.created_at;
    }
    return conversationId ? conversations.get(conversationId) || null : Array.from(conversations.values());
  }

  setSetting(scope, key, value, isSecret = false) {
    const rows = this.queryImpl(
      `insert into settings (id, scope, key, value, is_secret, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, now(), now())
       on conflict(scope, key) do update set
         value = excluded.value,
         is_secret = excluded.is_secret,
         updated_at = now()
       returning *`,
      [`${scope}_${key}`, scope, key, asJson(value), boolValue(isSecret)]
    );
    return mapSetting(rows[0]);
  }

  getSetting(scope, key) {
    const row = this.queryImpl("select * from settings where scope = $1 and key = $2", [scope, key])[0];
    return row ? mapSetting(row) : null;
  }

  listSettings(scope = null) {
    const rows = scope
      ? this.queryImpl("select * from settings where scope = $1 and is_secret = false order by key asc", [scope])
      : this.queryImpl("select * from settings where is_secret = false order by scope asc, key asc");
    return rows.map(mapSetting);
  }
}

module.exports = { PostgresRepository };
