const pageTitles = {
  "command-center": "Command Center",
  chat: "Chat",
  agents: "Agents",
  tasks: "Tasks",
  approvals: "Approval Queue",
  files: "Files",
  settings: "Settings"
};

let currentPermissions = [];
let chatConversations = [];
let activeConversationId = null;
let lastChatTaskSuggestion = null;
let dashboardFiles = [];
let dashboardTasks = [];

function can(permission) {
  return currentPermissions.includes(permission);
}

async function getJson(path) {
  const response = await fetch(path);
  if (response.status === 401) {
    showLogin();
  }
  if (!response.ok) {
    const message = await readErrorMessage(response, `Request failed: ${path}`);
    throw new Error(message);
  }
  return response.json();
}

async function readErrorMessage(response, fallback) {
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      return payload.message || payload.error || fallback;
    }
    const text = await response.text();
    return text ? text.slice(0, 500) : fallback;
  } catch {
    return fallback;
  }
}

function showLogin(message = "") {
  document.getElementById("auth-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
  if (message) {
    document.getElementById("login-result").textContent = message;
  }
}

function showApp(user) {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("current-user").textContent = user?.email || "";
  currentPermissions = user?.permissions || [];
  applyPermissions();
}

async function checkSession() {
  const response = await fetch("/api/auth/me");
  if (!response.ok) {
    showLogin("Login required.");
    return false;
  }
  const payload = await response.json();
  if (!payload.authenticated) {
    showLogin("Login required.");
    return false;
  }
  showApp(payload.user);
  return true;
}

function applyPermissions() {
  document.getElementById("create-task-button").disabled = !can("tasks:create");
  document.getElementById("command-input").disabled = !can("agents:execute");
  document.querySelector("#command-form button[type='submit']").disabled = !can("agents:execute");
  document.getElementById("file-upload-input").disabled = !can("files:upload");
  document.getElementById("file-task-input").disabled = !can("files:upload");
  document.querySelector("#file-upload-form button[type='submit']").disabled = !can("files:upload");

  const chatAllowed = can("chat:use");
  const chatNav = document.querySelector('[data-page-link="chat"]');
  if (chatNav) {
    chatNav.classList.toggle("disabled", !chatAllowed);
    chatNav.setAttribute("aria-disabled", String(!chatAllowed));
  }
  for (const id of [
    "chat-input",
    "chat-file-selector",
    "chat-task-selector",
    "chat-send-button",
    "chat-summarize-file-button",
    "chat-explain-task-button"
  ]) {
    const element = document.getElementById(id);
    if (element) {
      element.disabled = !chatAllowed;
    }
  }
  const createChatTaskButton = document.getElementById("chat-create-task-button");
  if (createChatTaskButton) {
    createChatTaskButton.disabled = !chatAllowed || !can("agents:execute");
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pill(label, extraClass = "") {
  return `<span class="pill ${escapeHtml(extraClass)}">${escapeHtml(label)}</span>`;
}

function renderList(elementId, items, renderItem, emptyText) {
  const element = document.getElementById(elementId);
  element.innerHTML = "";

  if (!items.length) {
    element.innerHTML = `<div class="item muted">${escapeHtml(emptyText)}</div>`;
    return;
  }

  for (const item of items) {
    const node = document.createElement("div");
    node.className = "item";
    node.innerHTML = renderItem(item);
    element.appendChild(node);
  }
}

function renderAgents(elementId, agents) {
  const element = document.getElementById(elementId);
  element.innerHTML = agents
    .map(
      (agent) => `
        <article class="agent-card">
          <div class="agent-card-header">
            <div>
              <strong>${escapeHtml(agent.name)}</strong>
              <div class="agent-type">${escapeHtml(agent.type)}</div>
            </div>
            ${pill(agent.status, agent.status)}
          </div>
          <div class="muted">${escapeHtml(agent.responsibilities.join(", "))}</div>
          <div class="muted">Model: ${escapeHtml(agent.defaultModel)}</div>
        </article>
      `
    )
    .join("");
}

function renderApproval(approval) {
  return `
    <strong>${escapeHtml(approval.title)}</strong>
    <div class="muted">
      ${pill(approval.approvalType)}
      ${pill(approval.riskLevel, approval.riskLevel)}
      ${pill(approval.status, approval.status)}
    </div>
    <div class="muted preline">${escapeHtml(approval.description)}</div>
    <div class="button-row">
      <button data-approval-action="approve" data-approval-id="${escapeHtml(approval.id)}">Approve</button>
      <button class="danger-button" data-approval-action="reject" data-approval-id="${escapeHtml(approval.id)}">Reject</button>
    </div>
  `;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function showPage(pageId) {
  const nextPage = pageTitles[pageId] ? pageId : "command-center";
  document.body.dataset.currentPage = nextPage;

  document.querySelectorAll("[data-page]").forEach((page) => {
    page.classList.toggle("active", page.dataset.page === nextPage);
  });
  document.querySelectorAll("[data-page-link]").forEach((link) => {
    link.classList.toggle("active", link.dataset.pageLink === nextPage);
  });
  document.getElementById("page-title").textContent = pageTitles[nextPage];
}

function normalizeConversations(history) {
  if (!history) {
    return [];
  }
  return Array.isArray(history) ? history : [history];
}

function conversationTitle(conversation) {
  const firstUserMessage = conversation.messages?.find((message) => message.role === "user");
  return firstUserMessage?.content?.slice(0, 54) || conversation.id || "New conversation";
}

function activeConversation() {
  return chatConversations.find((conversation) => conversation.id === activeConversationId) || chatConversations.at(-1);
}

function renderConversationList() {
  const element = document.getElementById("chat-conversation-list");
  if (!element) {
    return;
  }
  if (!can("chat:use")) {
    element.innerHTML = `<div class="chat-permission-note">Chat permission required.</div>`;
    return;
  }
  if (!chatConversations.length) {
    element.innerHTML = `<div class="chat-permission-note">No conversations yet.</div>`;
    return;
  }
  element.innerHTML = chatConversations
    .map(
      (conversation) => `
        <button
          class="conversation-button ${conversation.id === activeConversationId ? "active" : ""}"
          type="button"
          data-conversation-id="${escapeHtml(conversation.id)}"
        >
          ${escapeHtml(conversationTitle(conversation))}
          <span>${escapeHtml(conversation.messages?.length || 0)} messages</span>
        </button>
      `
    )
    .join("");
}

function renderChatMessages(conversation) {
  const element = document.getElementById("chat-messages");
  if (!element) {
    return;
  }
  if (!can("chat:use")) {
    element.innerHTML = `<div class="chat-permission-note">Your role does not include chat access.</div>`;
    return;
  }
  if (!conversation?.messages?.length) {
    element.innerHTML = `
      <div class="chat-state empty-state">
        <strong>Start a new chat</strong>
        <span>Ask a question, select a file to summarize, or select a task to explain.</span>
      </div>
    `;
    return;
  }
  element.innerHTML = conversation.messages
    .map(
      (message) => `
        <div class="message-row ${escapeHtml(message.role)}">
          <div class="message-bubble">
            <span class="message-role">${escapeHtml(message.role)}</span>
            <div class="preline">${escapeHtml(message.content)}</div>
          </div>
        </div>
      `
    )
    .join("");
  element.scrollTop = element.scrollHeight;
}

function renderChatPage(history) {
  chatConversations = normalizeConversations(history);
  if (!activeConversationId || !chatConversations.some((conversation) => conversation.id === activeConversationId)) {
    activeConversationId = chatConversations.at(-1)?.id || null;
  }
  renderConversationList();
  renderChatMessages(activeConversation());
}

function renderChatSelectors(files = dashboardFiles, tasks = dashboardTasks) {
  dashboardFiles = files;
  dashboardTasks = tasks;

  const fileSelector = document.getElementById("chat-file-selector");
  if (fileSelector) {
    const selected = fileSelector.value;
    fileSelector.innerHTML = [
      `<option value="">Select file</option>`,
      ...files.map(
        (file) =>
          `<option value="${escapeHtml(file.id)}">${escapeHtml(file.filename || file.path || file.id)}</option>`
      )
    ].join("");
    if (files.some((file) => file.id === selected)) {
      fileSelector.value = selected;
    }
  }

  const taskSelector = document.getElementById("chat-task-selector");
  if (taskSelector) {
    const selected = taskSelector.value;
    taskSelector.innerHTML = [
      `<option value="">Select task</option>`,
      ...tasks.map(
        (task) =>
          `<option value="${escapeHtml(task.id)}">${escapeHtml(task.title || task.id)}</option>`
      )
    ].join("");
    if (tasks.some((task) => task.id === selected)) {
      taskSelector.value = selected;
    }
  }
}

function renderChatError(message) {
  const element = document.getElementById("chat-messages");
  if (!element) {
    return;
  }
  element.innerHTML = `
    <div class="chat-state error-state">
      <strong>Chat request failed</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function latestTaskOutput(task) {
  const event = task.history?.find((item) => ["agent.result", "agent.failed", "test.run"].includes(item.eventType));
  if (!event) {
    return "No agent output yet.";
  }
  const payload = event.payload?.result || event.payload;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

function setChatStatus(message, loading = false) {
  const status = document.getElementById("chat-status");
  if (status) {
    status.textContent = loading ? "thinking" : message;
  }
  const typingIndicator = document.getElementById("chat-typing-indicator");
  if (typingIndicator) {
    typingIndicator.classList.toggle("hidden", !loading);
  }
  const sendButton = document.getElementById("chat-send-button");
  if (sendButton) {
    sendButton.disabled = loading || !can("chat:use");
  }
  for (const id of ["chat-summarize-file-button", "chat-explain-task-button"]) {
    const element = document.getElementById(id);
    if (element) {
      element.disabled = loading || !can("chat:use");
    }
  }
  const createChatTaskButton = document.getElementById("chat-create-task-button");
  if (createChatTaskButton) {
    createChatTaskButton.disabled = loading || !can("chat:use") || !can("agents:execute");
  }
}

async function loadDashboard() {
  const [health, agents, approvals, tasks, files, actionLog, permissions, database, storage, runtime, chatHistory] =
    await Promise.all([
      getJson("/api/health"),
      getJson("/api/agents"),
      can("approvals:read") ? getJson("/api/approvals?status=pending") : Promise.resolve({ approvals: [] }),
      can("tasks:read") ? getJson("/api/tasks") : Promise.resolve({ tasks: [] }),
      can("files:read") ? getJson("/api/files") : Promise.resolve({ files: [] }),
      can("settings:manage") ? getJson("/api/action-log") : Promise.resolve({ actions: [] }),
      getJson("/api/permissions"),
      getJson("/api/config/database"),
      getJson("/api/config/storage"),
      getJson("/api/config/runtime"),
      can("chat:use") ? getJson("/api/chat/history") : Promise.resolve({ history: [] })
    ]);

  const healthDot = document.getElementById("health-dot");
  const healthPill = document.getElementById("health-pill");
  healthDot.className = `status-dot ${health.ok ? "online" : "offline"}`;
  healthPill.textContent = health.ok ? "Runtime online" : "Runtime offline";

  document.getElementById("metric-agents").textContent = agents.agents.length;
  document.getElementById("metric-tasks").textContent = tasks.tasks.length;
  document.getElementById("metric-approvals").textContent = approvals.approvals.length;
  document.getElementById("metric-files").textContent = files.files.length;
  renderChatSelectors(files.files, tasks.tasks);

  renderAgents("agent-status-cards", agents.agents);
  renderAgents("agents-list", agents.agents);

  renderList(
    "recent-tasks-list",
    tasks.tasks.slice(0, 5),
    (task) => `
      <strong>${escapeHtml(task.title)}</strong>
      <div class="muted">${pill(task.status, task.status)} ${escapeHtml(task.assignedAgentId)}</div>
      <div class="muted">${escapeHtml(task.description || "No description")}</div>
    `,
    "No tasks yet."
  );

  renderList(
    "tasks-list",
    tasks.tasks,
    (task) => `
      <strong>${escapeHtml(task.title)}</strong>
      <div class="muted">${pill(task.status, task.status)} ${escapeHtml(task.assignedAgentId)}</div>
      <div class="muted">${escapeHtml(task.description || "No description")}</div>
      <div class="muted preline">${escapeHtml(latestTaskOutput(task))}</div>
      <div class="faint muted">Events: ${escapeHtml(task.history?.length || 0)}</div>
    `,
    "No tasks yet."
  );

  renderList("home-approvals-list", approvals.approvals.slice(0, 4), renderApproval, "No pending approvals.");
  renderList("approvals-list", approvals.approvals, renderApproval, "No pending approvals.");

  const latestConversation = Array.isArray(chatHistory.history)
    ? chatHistory.history.at(-1)
    : chatHistory.history;
  renderList(
    "chat-history-list",
    latestConversation?.messages?.slice(-6) || [],
    (message) => `
      <strong>${escapeHtml(message.role)}</strong>
      <div class="muted preline">${escapeHtml(message.content)}</div>
    `,
    "No chat messages yet."
  );
  renderChatPage(chatHistory.history);

  renderList(
    "files-list",
    files.files,
    (file) => `
      <strong>${escapeHtml(file.filename || "Untitled file")}</strong>
      <div class="muted">${escapeHtml(file.path || "No path")}</div>
      <div class="muted">${escapeHtml(file.provider)} - ${escapeHtml(file.bucket)} - ${escapeHtml(file.size_bytes)} bytes</div>
      <div class="button-row">
        <button data-file-action="read" data-file-id="${escapeHtml(file.id)}" ${can("files:read") ? "" : "disabled"}>Read</button>
        <button data-file-action="download" data-file-id="${escapeHtml(file.id)}" ${can("files:read") ? "" : "disabled"}>Download</button>
        <button class="danger-button" data-file-action="delete" data-file-id="${escapeHtml(file.id)}" ${can("files:delete") ? "" : "disabled"}>Delete</button>
      </div>
    `,
    "No stored files yet."
  );

  renderList(
    "action-log-list",
    actionLog.actions.slice(0, 20),
    (entry) => `
      <strong>${escapeHtml(entry.action)}</strong>
      <div class="muted">${escapeHtml(entry.createdAt)}</div>
      <div class="muted preline">${escapeHtml(JSON.stringify(entry.payload, null, 2))}</div>
    `,
    "No actions logged yet."
  );

  document.getElementById("settings-runtime").innerHTML = `
    <div class="setting-card">
      <strong>Environment</strong>
      <div class="muted">${escapeHtml(health.environment)}</div>
      <div class="faint muted">${escapeHtml(health.runtimeMode)}</div>
    </div>
    <div class="setting-card">
      <strong>Runtime Mode</strong>
      <div class="muted">${escapeHtml(runtime.runtime.mode)} - ${escapeHtml(runtime.runtime.networkPolicy)}</div>
      <div class="faint muted">Local AI implemented: ${escapeHtml(runtime.runtime.llm.localAiImplemented)}</div>
    </div>
    <div class="setting-card">
      <strong>LLM Provider</strong>
      <div class="muted">${escapeHtml(runtime.llmProvider.id)} - ${escapeHtml(runtime.llmProvider.status)}</div>
      <div class="faint muted">${escapeHtml(runtime.llmProvider.note)}</div>
    </div>
    <div class="setting-card">
      <strong>Database</strong>
      <div class="muted">${escapeHtml(database.database.provider)} - connected: ${escapeHtml(database.database.connected)}</div>
      <div class="faint muted">${escapeHtml(database.database.note)}</div>
    </div>
    <div class="setting-card">
      <strong>Storage</strong>
      <div class="muted">${escapeHtml(storage.storage.provider)} - bucket: ${escapeHtml(storage.storage.bucket)}</div>
      <div class="faint muted">Mode: ${escapeHtml(storage.storage.mode)} - Local path: ${escapeHtml(storage.storage.localPath)}</div>
      <div class="faint muted">Supabase: ${escapeHtml(storage.storage.supabaseConfigured)} - S3: ${escapeHtml(storage.storage.s3Configured)}</div>
    </div>
  `;
  applyPermissions();

  renderList(
    "settings-permissions",
    permissions.permissionModes,
    (mode) => `
      <strong>${escapeHtml(mode.label)}</strong>
      <div class="muted">${escapeHtml(mode.id)} - approval: ${escapeHtml(mode.requiresApproval)}</div>
      <div class="muted">${escapeHtml(mode.description)}</div>
    `,
    "No permission modes configured."
  );
}

async function uploadFile(event) {
  event.preventDefault();
  if (!can("files:upload")) {
    return;
  }
  const input = document.getElementById("file-upload-input");
  const taskInput = document.getElementById("file-task-input");
  const result = document.getElementById("file-result");
  const file = input.files[0];

  if (!file) {
    result.textContent = "Choose a file first.";
    return;
  }

  const taskId = taskInput.value.trim();
  const content = arrayBufferToBase64(await file.arrayBuffer());
  const response = await fetch("/api/files/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      path: `${taskId || "unassigned"}/${file.name}`,
      task_id: taskId || null,
      mime_type: file.type || "application/octet-stream",
      encoding: "base64",
      content
    })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  const payload = await response.json();
  result.textContent = `Uploaded ${payload.file.filename} to ${payload.file.path}`;
  input.value = "";
  await loadDashboard();
}

async function handleFileAction(event) {
  const button = event.target.closest("[data-file-action]");
  if (!button) {
    return;
  }

  const action = button.dataset.fileAction;
  const fileId = button.dataset.fileId;
  const result = document.getElementById("file-result");

  if (action === "download") {
    window.location.href = `/api/files/${fileId}/download`;
    return;
  }

  if (action === "read") {
    const payload = await getJson(`/api/files/${fileId}/read`);
    result.textContent = payload.content.slice(0, 500) || "File is empty.";
    return;
  }

  if (action === "delete") {
    const response = await fetch(`/api/files/${fileId}`, { method: "DELETE" });
    const payload = await response.json();
    result.textContent =
      payload.status === "approval_required"
        ? `Delete requires approval: ${payload.approval_id}`
        : `Deleted ${payload.file.filename}`;
    await loadDashboard();
  }
}

async function createDemoTask() {
  if (!can("tasks:create")) {
    return;
  }
  const response = await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Review TerminalX dashboard",
      description: "Inspect the new dark UI and agent status cards.",
      assignedAgentId: "ceo-agent"
    })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }

  await loadDashboard();
}

async function sendCommand(event) {
  event.preventDefault();
  if (!can("agents:execute")) {
    return;
  }
  const input = document.getElementById("command-input");
  const result = document.getElementById("command-result");
  const command = input.value.trim();

  if (!command) {
    result.textContent = "Enter a command for the CEO Agent first.";
    return;
  }

  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }

  const payload = await response.json();
  result.textContent = `${payload.selected_agent.name} -> ${payload.status}. ${payload.response}`;
  input.value = "";
  await loadDashboard();
}

async function sendChatMessage(event) {
  event.preventDefault();
  await sendChatRequest();
}

async function sendChatRequest(overrides = {}) {
  if (!can("chat:use")) {
    setChatStatus("blocked");
    return;
  }

  const input = document.getElementById("chat-input");
  const fileSelector = document.getElementById("chat-file-selector");
  const taskSelector = document.getElementById("chat-task-selector");
  const message = String(overrides.message ?? input.value).trim();
  const fileId = String(overrides.file_id ?? fileSelector.value).trim();
  const taskId = String(overrides.task_id ?? taskSelector.value).trim();

  if (!message) {
    setChatStatus("ready");
    return;
  }

  setChatStatus("thinking", true);
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      conversation_id: activeConversationId,
      file_id: fileId || null,
      task_id: taskId || null
    })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  if (response.status === 403) {
    setChatStatus("forbidden");
    renderChatError("Your role does not allow chat access.");
    return;
  }
  if (!response.ok) {
    setChatStatus("error");
    const message = await readErrorMessage(response, "The Chat Agent could not complete this request.");
    renderChatError(message);
    return;
  }

  const payload = await response.json();
  activeConversationId = payload.conversation_id;
  lastChatTaskSuggestion = payload.task_suggestions?.[0] || {
    title: "Chat follow-up",
    command: message
  };
  input.value = "";
  setChatStatus("ready");
  await loadDashboard();
}

async function summarizeSelectedFile() {
  const fileSelector = document.getElementById("chat-file-selector");
  const fileId = fileSelector.value;
  if (!fileId) {
    renderChatError("Select a file first.");
    setChatStatus("error");
    return;
  }
  const file = dashboardFiles.find((item) => item.id === fileId);
  await sendChatRequest({
    message: `Summarize file ${file?.filename || fileId}`,
    file_id: fileId,
    task_id: null
  });
}

async function explainSelectedTask() {
  const taskSelector = document.getElementById("chat-task-selector");
  const taskId = taskSelector.value;
  if (!taskId) {
    renderChatError("Select a task first.");
    setChatStatus("error");
    return;
  }
  const task = dashboardTasks.find((item) => item.id === taskId);
  await sendChatRequest({
    message: `Explain task ${task?.title || taskId}`,
    file_id: null,
    task_id: taskId
  });
}

function selectConversation(event) {
  const button = event.target.closest("[data-conversation-id]");
  if (!button) {
    return;
  }
  activeConversationId = button.dataset.conversationId;
  renderConversationList();
  renderChatMessages(activeConversation());
}

async function createTaskFromChat() {
  if (!can("chat:use") || !can("agents:execute")) {
    return;
  }
  const input = document.getElementById("chat-input");
  const draft = input.value.trim();
  const suggestion = lastChatTaskSuggestion || {
    title: "Chat follow-up",
    command: draft || "Create a task suggestion from the current chat conversation."
  };
  const command = draft || suggestion.command;
  if (!command) {
    setChatStatus("ready");
    return;
  }

  setChatStatus("routing", true);
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: `Create CEO task suggestion: ${command}`,
      conversation_id: activeConversationId
    })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  setChatStatus(response.ok ? "sent" : "error");
  await loadDashboard();
}

async function login(event) {
  event.preventDefault();
  const result = document.getElementById("login-result");
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: document.getElementById("login-email").value.trim(),
      password: document.getElementById("login-password").value
    })
  });

  if (!response.ok) {
    result.textContent = "Login failed.";
    return;
  }

  const payload = await response.json();
  showApp(payload.user);
  await loadDashboard();
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  showLogin("Logged out.");
}

async function decideApproval(event) {
  const button = event.target.closest("[data-approval-action]");
  if (!button) {
    return;
  }
  if (!can("approvals:approve")) {
    return;
  }

  const action = button.dataset.approvalAction;
  const approvalId = button.dataset.approvalId;
  await fetch(`/api/approvals/${approvalId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decidedBy: "dashboard" })
  });
  await loadDashboard();
}

window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
document.getElementById("login-form").addEventListener("submit", login);
document.getElementById("logout-button").addEventListener("click", logout);
document.getElementById("create-task-button").addEventListener("click", createDemoTask);
document.getElementById("command-form").addEventListener("submit", sendCommand);
document.getElementById("chat-form").addEventListener("submit", sendChatMessage);
document.getElementById("chat-conversation-list").addEventListener("click", selectConversation);
document.getElementById("chat-create-task-button").addEventListener("click", createTaskFromChat);
document.getElementById("chat-summarize-file-button").addEventListener("click", summarizeSelectedFile);
document.getElementById("chat-explain-task-button").addEventListener("click", explainSelectedTask);
document.getElementById("approvals-list").addEventListener("click", decideApproval);
document.getElementById("home-approvals-list").addEventListener("click", decideApproval);
document.getElementById("file-upload-form").addEventListener("submit", uploadFile);
document.getElementById("files-list").addEventListener("click", handleFileAction);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.warn("TerminalX service worker registration failed", error);
    });
  });
}

showPage(location.hash.slice(1));
checkSession()
  .then((authenticated) => {
    if (authenticated) {
      return loadDashboard();
    }
    return null;
  })
  .catch(() => {
    document.getElementById("health-dot").className = "status-dot offline";
    document.getElementById("health-pill").textContent = "Runtime offline";
    showLogin("Runtime offline.");
  });
