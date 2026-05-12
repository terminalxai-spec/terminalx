const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { PostgresRepository } = require("./postgres-repository");

let sqliteModule = null;
try {
  sqliteModule = require("node:sqlite");
} catch {
  sqliteModule = null;
}

let idCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function maskConnectionString(value) {
  if (!value) {
    return null;
  }

  return value.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
}

function resolveDatabaseSettings() {
  const url = process.env.DATABASE_URL || "";
  const requestedProvider = String(process.env.DATABASE_PROVIDER || "").toLowerCase();
  const isPostgresUrl = /^postgres(ql)?:\/\//i.test(url);
  const sqlitePath = process.env.SQLITE_PATH || process.env.SQLITE_DATABASE_PATH || "./storage/local/terminalx.db";
  const provider = requestedProvider || (isPostgresUrl ? "postgres" : "sqlite");

  return {
    provider,
    url,
    sqlitePath,
    isPostgresUrl
  };
}

function getDatabaseConfig() {
  const settings = resolveDatabaseSettings();
  const postgresCliAvailable = Boolean(spawnSync("psql", ["--version"], { encoding: "utf8" }).stdout);
  const sqliteAvailable = Boolean(sqliteModule?.DatabaseSync);

  return {
    connected: settings.provider === "postgres" ? Boolean(settings.url) : sqliteAvailable,
    provider: settings.provider,
    requestedProvider: settings.provider,
    url: maskConnectionString(settings.url),
    sqlitePath: settings.sqlitePath,
    fallback: false,
    postgresMigrationAvailable: settings.provider === "postgres" && Boolean(settings.url) && postgresCliAvailable,
    supabaseCompatible: true,
    note:
      settings.provider === "postgres"
        ? "Using PostgreSQL runtime repository. Keep DATABASE_URL server-side only."
        : "Using SQLite runtime repository for local/offline development."
  };
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

function stringifyJson(value) {
  return JSON.stringify(value ?? {});
}

function createSqliteDatabase(filePath) {
  if (!sqliteModule?.DatabaseSync) {
    throw new Error("node:sqlite is not available in this Node.js runtime.");
  }

  if (filePath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
  }

  const db = new sqliteModule.DatabaseSync(filePath === ":memory:" ? filePath : path.resolve(process.cwd(), filePath));
  db.exec(`
    pragma journal_mode = wal;
    create table if not exists users (
      id text primary key,
      email text unique,
      display_name text,
      password_hash text,
      role text not null default 'operator',
      created_at text not null,
      updated_at text not null
    );
    create table if not exists sessions (
      id text primary key,
      user_id text not null,
      token_hash text not null unique,
      expires_at text not null,
      created_at text not null,
      revoked_at text
    );
    create table if not exists login_audit_logs (
      id text primary key,
      user_id text,
      email text,
      action text not null,
      success integer not null default 0,
      ip_address text,
      user_agent text,
      created_at text not null
    );
    create table if not exists roles (
      id text primary key,
      label text not null,
      description text,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists user_roles (
      user_id text not null,
      role_id text not null,
      created_at text not null,
      primary key (user_id, role_id)
    );
    create table if not exists role_permissions (
      role_id text not null,
      permission_name text not null,
      created_at text not null,
      primary key (role_id, permission_name)
    );
    create table if not exists agents (
      id text primary key,
      name text not null,
      type text not null,
      status text not null,
      default_model text,
      responsibilities text not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists tasks (
      id text primary key,
      user_id text,
      title text not null,
      description text,
      status text not null,
      assigned_agent_id text,
      intent text,
      approval_required integer not null default 0,
      risk_level text not null default 'low',
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists task_history (
      id text primary key,
      task_id text not null,
      event_type text not null,
      payload text not null,
      created_at text not null
    );
    create table if not exists approvals (
      id text primary key,
      task_id text,
      title text not null,
      status text not null,
      approval_type text not null,
      risk_level text not null,
      requested_by text not null,
      assigned_agent_id text,
      description text,
      proposed_action text not null,
      decided_by text,
      decided_at text,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists files (
      id text primary key,
      task_id text,
      filename text not null,
      storage_provider text not null default 'local',
      storage_key text,
      path text not null,
      mime_type text not null,
      size integer not null default 0,
      size_bytes integer not null,
      mode text,
      provider text not null,
      bucket text not null,
      online_configured integer not null,
      metadata text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists chat_history (
      id text primary key,
      conversation_id text not null,
      agent_id text not null,
      role text not null,
      content text not null,
      metadata text not null,
      created_at text not null
    );
    create table if not exists agent_logs (
      id text primary key,
      agent_id text,
      action text not null,
      payload text not null,
      created_at text not null
    );
    create table if not exists permissions (
      id text primary key,
      label text not null,
      description text,
      requires_approval integer not null,
      risk_level text not null,
      policy text not null,
      created_at text not null,
      updated_at text not null
    );
    create table if not exists settings (
      id text primary key,
      scope text not null default 'system',
      key text not null,
      value text not null,
      is_secret integer not null default 0,
      created_at text not null,
      updated_at text not null,
      unique (scope, key)
    );
  `);
  const fileColumns = db.prepare("pragma table_info(files)").all().map((column) => column.name);
  if (!fileColumns.includes("storage_provider")) {
    db.exec("alter table files add column storage_provider text not null default 'local'");
  }
  if (!fileColumns.includes("storage_key")) {
    db.exec("alter table files add column storage_key text");
  }
  if (!fileColumns.includes("size")) {
    db.exec("alter table files add column size integer not null default 0");
  }
  const userColumns = db.prepare("pragma table_info(users)").all().map((column) => column.name);
  if (!userColumns.includes("password_hash")) {
    db.exec("alter table users add column password_hash text");
  }
  return db;
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

function mapHistory(row) {
  return {
    id: row.id,
    eventType: row.event_type,
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

function createSqliteRepository(options = {}) {
  const settings = resolveDatabaseSettings();
  const dbPath = options.databasePath || process.env.SQLITE_PATH || process.env.SQLITE_DATABASE_PATH || settings.sqlitePath;
  const db = createSqliteDatabase(options.memory ? ":memory:" : dbPath);

  function taskHistory(taskId) {
    return db
      .prepare("select * from task_history where task_id = ? order by created_at desc")
      .all(taskId)
      .map(mapHistory);
  }

  return {
    kind: "sqlite",
    config: {
      connected: true,
      provider: "sqlite",
      requestedProvider: settings.provider,
      sqlitePath: options.memory ? ":memory:" : dbPath,
      fallback: settings.provider === "postgres",
      supabaseCompatible: true,
      note: "Using local SQLite repository."
    },
    close() {
      db.close();
    },
    seedAgents(agents) {
      const statement = db.prepare(`
        insert into agents (id, name, type, status, default_model, responsibilities, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          name = excluded.name,
          type = excluded.type,
          status = excluded.status,
          default_model = excluded.default_model,
          responsibilities = excluded.responsibilities,
          updated_at = excluded.updated_at
      `);
      const createdAt = nowIso();
      for (const agent of agents) {
        statement.run(
          agent.id,
          agent.name,
          agent.type,
          agent.status,
          agent.defaultModel,
          stringifyJson(agent.responsibilities || []),
          stringifyJson(agent.metadata || {}),
          createdAt,
          createdAt
        );
      }
    },
    seedPermissions(permissionModes) {
      const statement = db.prepare(`
        insert into permissions (id, label, description, requires_approval, risk_level, policy, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          label = excluded.label,
          description = excluded.description,
          requires_approval = excluded.requires_approval,
          risk_level = excluded.risk_level,
          policy = excluded.policy,
          updated_at = excluded.updated_at
      `);
      const createdAt = nowIso();
      for (const mode of permissionModes) {
        statement.run(
          mode.id,
          mode.label,
          mode.description,
          mode.requiresApproval ? 1 : 0,
          mode.riskLevel || "low",
          stringifyJson(mode),
          createdAt,
          createdAt
        );
      }
    },
    seedSettings(settingsPayload = {}) {
      for (const [key, value] of Object.entries(settingsPayload)) {
        this.setSetting("system", key, value, false);
      }
    },
    createUser({ id = crypto.randomUUID(), email, passwordHash, displayName = "", role = "operator" }) {
      const createdAt = nowIso();
      db.prepare(`
        insert into users (id, email, display_name, password_hash, role, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `).run(id, String(email || "").toLowerCase(), displayName, passwordHash, role, createdAt, createdAt);
      return this.findUserByEmail(email);
    },
    upsertUser({ id = crypto.randomUUID(), email, passwordHash, displayName = "", role = "operator" }) {
      const createdAt = nowIso();
      db.prepare(`
        insert into users (id, email, display_name, password_hash, role, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(email) do update set
          display_name = excluded.display_name,
          password_hash = excluded.password_hash,
          role = excluded.role,
          updated_at = excluded.updated_at
      `).run(id, String(email || "").toLowerCase(), displayName, passwordHash, role, createdAt, createdAt);
      return this.findUserByEmail(email);
    },
    findUserByEmail(email) {
      const row = db.prepare("select * from users where email = ?").get(String(email || "").toLowerCase());
      return row ? mapUser(row) : null;
    },
    findUserById(id) {
      const row = db.prepare("select * from users where id = ?").get(id);
      return row ? mapUser(row) : null;
    },
    createSession({ id = createId("session"), userId, tokenHash, expiresAt }) {
      const createdAt = nowIso();
      db.prepare("insert into sessions (id, user_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)")
        .run(id, userId, tokenHash, expiresAt, createdAt);
      return { id, userId, tokenHash, expiresAt, createdAt };
    },
    findSessionByTokenHash(tokenHash) {
      const row = db.prepare("select * from sessions where token_hash = ? and revoked_at is null").get(tokenHash);
      if (!row || Date.parse(row.expires_at) <= Date.now()) {
        return null;
      }
      return {
        id: row.id,
        userId: row.user_id,
        tokenHash: row.token_hash,
        expiresAt: row.expires_at,
        createdAt: row.created_at
      };
    },
    revokeSession(tokenHash) {
      db.prepare("update sessions set revoked_at = ? where token_hash = ?").run(nowIso(), tokenHash);
      return true;
    },
    logLoginAudit({ userId = null, email = "", action, success = false, ipAddress = "", userAgent = "" }) {
      const entry = {
        id: createId("login_audit"),
        userId,
        email,
        action,
        success,
        ipAddress,
        userAgent,
        createdAt: nowIso()
      };
      db.prepare(`
        insert into login_audit_logs (id, user_id, email, action, success, ip_address, user_agent, created_at)
        values (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entry.id, userId, email, action, success ? 1 : 0, ipAddress, userAgent, entry.createdAt);
      return entry;
    },
    upsertRole({ id, label, description = "" }) {
      const createdAt = nowIso();
      db.prepare(`
        insert into roles (id, label, description, created_at, updated_at)
        values (?, ?, ?, ?, ?)
        on conflict(id) do update set
          label = excluded.label,
          description = excluded.description,
          updated_at = excluded.updated_at
      `).run(id, label, description, createdAt, createdAt);
      return { id, label, description };
    },
    assignRole(userId, roleId) {
      db.prepare("insert or ignore into user_roles (user_id, role_id, created_at) values (?, ?, ?)")
        .run(userId, roleId, nowIso());
      return true;
    },
    setRolePermissions(roleId, permissions = []) {
      db.prepare("delete from role_permissions where role_id = ?").run(roleId);
      const statement = db.prepare("insert into role_permissions (role_id, permission_name, created_at) values (?, ?, ?)");
      for (const permission of permissions) {
        statement.run(roleId, permission, nowIso());
      }
      return permissions;
    },
    listUserRoles(userId) {
      return db.prepare("select role_id from user_roles where user_id = ? order by role_id asc").all(userId).map((row) => row.role_id);
    },
    listUserPermissions(userId) {
      return db
        .prepare(`
          select distinct rp.permission_name
          from user_roles ur
          join role_permissions rp on rp.role_id = ur.role_id
          where ur.user_id = ?
          order by rp.permission_name asc
        `)
        .all(userId)
        .map((row) => row.permission_name);
    },
    createTask(payload) {
      const createdAt = nowIso();
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
        history: [],
        createdAt,
        updatedAt: createdAt
      };
      db.prepare(`
        insert into tasks (id, title, description, status, assigned_agent_id, intent, approval_required, risk_level, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.title,
        task.description,
        task.status,
        task.assignedAgentId,
        task.intent,
        task.approvalRequired ? 1 : 0,
        task.riskLevel,
        stringifyJson(task.metadata),
        task.createdAt,
        task.updatedAt
      );
      return task;
    },
    listTasks() {
      return db
        .prepare("select * from tasks order by created_at desc")
        .all()
        .map((row) => mapTask(row, taskHistory(row.id)));
    },
    findTask(taskId) {
      const row = db.prepare("select * from tasks where id = ?").get(taskId);
      return row ? mapTask(row, taskHistory(row.id)) : null;
    },
    updateTaskStatus(taskId, status, metadata = {}) {
      const task = this.findTask(taskId);
      if (!task) {
        return null;
      }
      const updatedAt = nowIso();
      const nextMetadata = {
        ...(task.metadata || {}),
        ...(metadata || {})
      };
      db.prepare("update tasks set status = ?, metadata = ?, updated_at = ? where id = ?")
        .run(status, stringifyJson(nextMetadata), updatedAt, taskId);
      return this.findTask(taskId);
    },
    appendTaskHistory(taskId, eventType, payload) {
      if (!taskId || !this.findTask(taskId)) {
        return null;
      }
      const createdAt = nowIso();
      const event = {
        id: createId("event"),
        eventType,
        payload,
        createdAt
      };
      db.prepare("insert into task_history (id, task_id, event_type, payload, created_at) values (?, ?, ?, ?, ?)")
        .run(event.id, taskId, eventType, stringifyJson(payload), createdAt);
      db.prepare("update tasks set updated_at = ? where id = ?").run(createdAt, taskId);
      return event;
    },
    listApprovals(filter = {}) {
      const rows = filter.status
        ? db.prepare("select * from approvals where status = ? order by created_at desc").all(filter.status)
        : db.prepare("select * from approvals order by created_at desc").all();
      return rows.map(mapApproval);
    },
    getApproval(id) {
      const row = db.prepare("select * from approvals where id = ?").get(id);
      return row ? mapApproval(row) : null;
    },
    addApproval(approval) {
      const createdAt = approval.createdAt || nowIso();
      const storedApproval = {
        ...approval,
        id: approval.id || createId("approval"),
        status: approval.status || "pending",
        approvalType: approval.approvalType || "risky_action",
        riskLevel: approval.riskLevel || "medium",
        requestedBy: approval.requestedBy || "system",
        proposedAction: approval.proposedAction || {},
        createdAt,
        updatedAt: createdAt
      };
      db.prepare(`
        insert into approvals (id, task_id, title, status, approval_type, risk_level, requested_by, assigned_agent_id, description, proposed_action, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        storedApproval.id,
        storedApproval.taskId || null,
        storedApproval.title,
        storedApproval.status,
        storedApproval.approvalType,
        storedApproval.riskLevel,
        storedApproval.requestedBy,
        storedApproval.assignedAgentId || null,
        storedApproval.description || "",
        stringifyJson(storedApproval.proposedAction),
        storedApproval.createdAt,
        storedApproval.updatedAt
      );
      return storedApproval;
    },
    decideApproval(id, status, decidedBy = "user") {
      const approval = this.getApproval(id);
      if (!approval) {
        return null;
      }
      const decidedAt = nowIso();
      db.prepare("update approvals set status = ?, decided_by = ?, decided_at = ?, updated_at = ? where id = ?")
        .run(status, decidedBy, decidedAt, decidedAt, id);
      return this.getApproval(id);
    },
    logAction(action, payload = {}, agentId = null) {
      const entry = {
        id: createId("log"),
        action,
        payload,
        agentId,
        createdAt: nowIso()
      };
      db.prepare("insert into agent_logs (id, agent_id, action, payload, created_at) values (?, ?, ?, ?, ?)")
        .run(entry.id, agentId, action, stringifyJson(payload), entry.createdAt);
      return entry;
    },
    listLogs() {
      return db.prepare("select * from agent_logs order by created_at desc").all().map(mapLog);
    },
    upsertFile(record) {
      const createdAt = record.createdAt || nowIso();
      const updatedAt = record.updatedAt || createdAt;
      db.prepare(`
        insert into files (id, task_id, filename, storage_provider, storage_key, path, mime_type, size, size_bytes, mode, provider, bucket, online_configured, metadata, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at
      `).run(
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
        record.onlineConfigured ? 1 : 0,
        stringifyJson(record.metadata || {}),
        createdAt,
        updatedAt
      );
      return this.getFile(record.id);
    },
    listFiles(filter = {}) {
      const rows = filter.task_id
        ? db.prepare("select * from files where task_id = ? order by created_at desc").all(filter.task_id)
        : db.prepare("select * from files order by created_at desc").all();
      return rows.map(mapFile);
    },
    getFile(fileId) {
      const row = db.prepare("select * from files where id = ?").get(fileId);
      return row ? mapFile(row) : null;
    },
    deleteFile(fileId) {
      const record = this.getFile(fileId);
      if (!record) {
        return null;
      }
      db.prepare("delete from files where id = ?").run(fileId);
      return record;
    },
    appendChatMessage({ conversationId, agentId, role, content, metadata = {} }) {
      const message = {
        id: createId("msg"),
        conversationId,
        agentId,
        role,
        content,
        metadata,
        createdAt: nowIso()
      };
      db.prepare(`
        insert into chat_history (id, conversation_id, agent_id, role, content, metadata, created_at)
        values (?, ?, ?, ?, ?, ?, ?)
      `).run(message.id, conversationId, agentId, role, content, stringifyJson(metadata), message.createdAt);
      return message;
    },
    listConversations(conversationId) {
      const rows = conversationId
        ? db.prepare("select * from chat_history where conversation_id = ? order by created_at asc").all(conversationId)
        : db.prepare("select * from chat_history order by conversation_id asc, created_at asc").all();
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
      return conversationId
        ? conversations.get(conversationId) || null
        : Array.from(conversations.values());
    },
    setSetting(scope, key, value, isSecret = false) {
      const createdAt = nowIso();
      const id = `${scope}_${key}`;
      db.prepare(`
        insert into settings (id, scope, key, value, is_secret, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?, ?)
        on conflict(scope, key) do update set
          value = excluded.value,
          is_secret = excluded.is_secret,
          updated_at = excluded.updated_at
      `).run(id, scope, key, stringifyJson(value), isSecret ? 1 : 0, createdAt, createdAt);
      return this.getSetting(scope, key);
    },
    getSetting(scope, key) {
      const row = db.prepare("select * from settings where scope = ? and key = ?").get(scope, key);
      return row ? mapSetting(row) : null;
    },
    listSettings(scope = null) {
      const rows = scope
        ? db.prepare("select * from settings where scope = ? order by key asc").all(scope)
        : db.prepare("select * from settings order by scope asc, key asc").all();
      return rows.map(mapSetting).filter((setting) => !setting.isSecret);
    }
  };
}

function createDatabaseRepository(options = {}) {
  const settings = resolveDatabaseSettings();
  if (options.memory || process.env.NODE_ENV === "test") {
    return createSqliteRepository({
      memory: true,
      databasePath: options.databasePath || settings.sqlitePath
    });
  }

  if (settings.provider === "postgres") {
    return new PostgresRepository({
      databaseUrl: settings.url,
      query: options.query
    });
  }

  return createSqliteRepository({
    memory: false,
    databasePath: options.databasePath || settings.sqlitePath
  });
}

function migrateSqlite(databasePath = resolveDatabaseSettings().sqlitePath) {
  const db = createSqliteDatabase(databasePath);
  db.close();
  return {
    provider: "sqlite",
    path: databasePath,
    migrated: true
  };
}

function migratePostgres(migrationPath = path.resolve(process.cwd(), "migrations/001_initial_schema.sql")) {
  const settings = resolveDatabaseSettings();
  if (!settings.url) {
    throw new Error("DATABASE_URL is required for PostgreSQL migration.");
  }

  const result = spawnSync("psql", [settings.url, "-v", "ON_ERROR_STOP=1", "-f", migrationPath], {
    encoding: "utf8",
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || "PostgreSQL migration failed.");
  }

  return {
    provider: "postgres",
    migrated: true,
    stdout: result.stdout
  };
}

function migrateDatabase() {
  const settings = resolveDatabaseSettings();
  if (settings.provider === "postgres") {
    return migratePostgres();
  }
  return migrateSqlite(settings.sqlitePath);
}

module.exports = {
  createDatabaseRepository,
  createSqliteRepository,
  getDatabaseConfig,
  migrateDatabase,
  migratePostgres,
  migrateSqlite,
  PostgresRepository,
  resolveDatabaseSettings
};
