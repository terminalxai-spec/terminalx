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
let lastCreatedTaskId = null;
let dashboardFiles = [];
let dashboardTasks = [];
let dashboardApprovals = [];
let dashboardActionLog = [];
let isGenerating = false;
let stopGeneration = false;
let pendingAttachmentFile = null;
let fileSearchTerm = "";
let conversationPreferences = {};
try {
  conversationPreferences = JSON.parse(localStorage.getItem("terminalx.conversations") || "{}");
} catch {
  conversationPreferences = {};
}

function can(permission) {
  return currentPermissions.includes(permission);
}

function apiFetch(path, options = {}) {
  return fetch(path, {
    ...options,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(options.body && !options.headers?.["content-type"] ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
}

async function getJson(path) {
  const response = await apiFetch(path);
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

function toggleSidebar() {
  document.getElementById("app-shell").classList.toggle("sidebar-collapsed");
}

async function checkSession() {
  const response = await apiFetch("/api/auth/me");
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

function formatTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function saveConversationPreferences() {
  localStorage.setItem("terminalx.conversations", JSON.stringify(conversationPreferences));
}

function renderMarkdown(value) {
  const codeBlocks = [];
  let text = String(value || "").replace(/```(\w+)?\n([\s\S]*?)```/g, (_, language, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({ language: language || "text", code });
    return `@@CODE_BLOCK_${index}@@`;
  });

  text = escapeHtml(text)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h3>$1</h3>")
    .replace(/^# (.*)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br />");

  text = `<p>${text}</p>`.replace(/<p><\/p>/g, "");
  return text.replace(/@@CODE_BLOCK_(\d+)@@/g, (_, index) => {
    const block = codeBlocks[Number(index)];
    return `
      <div class="code-card">
        <div class="code-toolbar">
          <span>${escapeHtml(block.language)}</span>
          <button class="mini-button" type="button" data-copy-code="${escapeHtml(block.code)}">Copy</button>
        </div>
        <pre><code>${escapeHtml(block.code)}</code></pre>
      </div>
    `;
  });
}

function showToast(message, type = "info") {
  const region = document.getElementById("toast-region");
  if (!region) {
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  region.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function pushActivity(message, type = "agent") {
  dashboardActionLog = [
    {
      id: `local_${Date.now()}`,
      action: message,
      payload: { type },
      createdAt: new Date().toISOString()
    },
    ...dashboardActionLog
  ].slice(0, 30);
  renderActivityFeed();
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
  const approvalDisabled = can("approvals:approve") ? "" : "disabled";
  const approvalHelp = can("approvals:approve")
    ? ""
    : `<div class="muted">Your current role can view approvals but cannot approve or reject them.</div>`;
  return `
    <strong>${escapeHtml(approval.title)}</strong>
    <div class="muted">
      ${pill(approval.approvalType)}
      ${pill(approval.riskLevel, approval.riskLevel)}
      ${pill(approval.status, approval.status)}
    </div>
    <div class="muted preline">${escapeHtml(approval.description)}</div>
    ${approvalHelp}
    <div class="button-row">
      <button data-approval-action="approve" data-approval-id="${escapeHtml(approval.id)}" ${approvalDisabled}>Approve</button>
      <button class="danger-button" data-approval-action="reject" data-approval-id="${escapeHtml(approval.id)}" ${approvalDisabled}>Reject</button>
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
  const customTitle = conversationPreferences[conversation.id]?.title;
  if (customTitle) {
    return customTitle;
  }
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
    .filter((conversation) => !conversationPreferences[conversation.id]?.deleted)
    .map(
      (conversation) => `
        <button
          class="conversation-button ${conversation.id === activeConversationId ? "active" : ""}"
          type="button"
          data-conversation-id="${escapeHtml(conversation.id)}"
        >
          ${escapeHtml(conversationTitle(conversation))}
          <span>${escapeHtml(conversation.messages?.length || 0)} messages - ${escapeHtml(formatTime(conversation.updatedAt || conversation.createdAt))}</span>
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
      <div class="chat-state empty-state premium-empty-state">
        <strong>What should TerminalX do next?</strong>
        <span>Start with an operational prompt or turn a conversation into a task.</span>
        <div class="suggestion-grid">
          <button type="button" data-example-prompt="Create simple calculator">Create simple calculator</button>
          <button type="button" data-example-prompt="Summarize my latest uploaded file">Summarize uploaded file</button>
          <button type="button" data-example-prompt="Plan a content calendar for TerminalX">Plan content calendar</button>
          <button type="button" data-example-prompt="Analyze BTC risk with stop loss">Analyze trading risk</button>
        </div>
      </div>
    `;
    return;
  }
  element.innerHTML = conversation.messages
    .map((message, index) => {
      const timestamp = formatTime(message.createdAt);
      return `
        <div class="message-row ${escapeHtml(message.role)}">
          <div class="message-bubble">
            <div class="message-meta">
              <span class="message-role">${escapeHtml(message.role)}</span>
              <time>${escapeHtml(timestamp)}</time>
            </div>
            <div class="markdown-body">${renderMarkdown(message.content)}</div>
            ${
              message.role === "assistant"
                ? `<div class="message-actions">
                    <button class="mini-button" type="button" data-copy-message="${index}">Copy</button>
                    <button class="mini-button" type="button" data-regenerate-message="${index}">Regenerate</button>
                  </div>`
                : ""
            }
          </div>
        </div>
      `;
    })
    .join("");
  element.scrollTop = element.scrollHeight;
}

function appendLocalMessage(role, content, metadata = {}) {
  const id = activeConversationId || `local_chat_${Date.now()}`;
  activeConversationId = id;
  let conversation = chatConversations.find((item) => item.id === id);
  if (!conversation) {
    conversation = {
      id,
      agentId: "chat-agent",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    chatConversations.push(conversation);
  }
  conversation.messages.push({
    id: `local_msg_${Date.now()}_${conversation.messages.length}`,
    role,
    content,
    metadata,
    createdAt: new Date().toISOString()
  });
  conversation.updatedAt = new Date().toISOString();
  renderConversationList();
  renderChatMessages(conversation);
  return conversation.messages.at(-1);
}

async function streamAssistantMessage(fullText) {
  const conversation = activeConversation();
  if (!conversation) {
    return;
  }
  const message = appendLocalMessage("assistant", "", { streaming: true });
  const tokens = String(fullText || "").split(/(\s+)/);
  for (const token of tokens) {
    if (stopGeneration) {
      message.content += "\n\n[Stopped]";
      break;
    }
    message.content += token;
    renderChatMessages(conversation);
    await new Promise((resolve) => window.setTimeout(resolve, 12));
  }
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

function renderChatTaskResult(payload) {
  const element = document.getElementById("chat-task-result");
  if (!element) {
    return;
  }
  if (!payload?.task_id) {
    element.classList.add("hidden");
    element.innerHTML = "";
    return;
  }
  lastCreatedTaskId = payload.task_id;
  const agentName = payload.selected_agent?.name || "Coding Agent";
  element.classList.remove("hidden");
  element.innerHTML = `
    <div>
      <strong>Task created and assigned to ${escapeHtml(agentName)}</strong>
      <span>${escapeHtml(payload.task?.title || payload.response || payload.task_id)}</span>
    </div>
    <button class="secondary-button" type="button" data-open-task="${escapeHtml(payload.task_id)}">Open Task</button>
  `;
}

function renderChatStatusResult(report) {
  const element = document.getElementById("chat-task-result");
  if (!element) {
    return;
  }
  if (!report?.task?.id) {
    return;
  }
  lastCreatedTaskId = report.task.id;
  element.classList.remove("hidden");
  element.innerHTML = `
    <div>
      <strong>${escapeHtml(report.task.title)}</strong>
      <span>${escapeHtml(report.task.assigned_agent)} - ${escapeHtml(report.task.current_status)}</span>
      <span>${escapeHtml(report.task.pending_approval ? "Approval required" : report.task.next_action)}</span>
    </div>
    <button class="secondary-button" type="button" data-open-task="${escapeHtml(report.task.id)}">Open Task</button>
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
  isGenerating = loading;
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
  const stopButton = document.getElementById("chat-stop-button");
  if (stopButton) {
    stopButton.classList.toggle("hidden", !loading);
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

function renderActivityFeed() {
  const element = document.getElementById("activity-feed");
  if (!element) {
    return;
  }
  const taskEvents = dashboardTasks.slice(0, 8).map((task) => ({
    label: `${task.assignedAgentId || "Agent"} ${task.status}`,
    detail: task.title,
    createdAt: task.updatedAt || task.createdAt,
    type: task.status
  }));
  const approvalEvents = dashboardApprovals.slice(0, 5).map((approval) => ({
    label: "Approval required",
    detail: approval.title,
    createdAt: approval.createdAt,
    type: "approval"
  }));
  const logEvents = dashboardActionLog.slice(0, 8).map((entry) => ({
    label: entry.action,
    detail: JSON.stringify(entry.payload || {}).slice(0, 120),
    createdAt: entry.createdAt,
    type: entry.payload?.type || "log"
  }));
  const events = [...taskEvents, ...approvalEvents, ...logEvents]
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, 12);
  element.innerHTML = events.length
    ? events
        .map(
          (event) => `
            <div class="activity-item ${escapeHtml(event.type)}">
              <span></span>
              <div>
                <strong>${escapeHtml(event.label)}</strong>
                <p>${escapeHtml(event.detail || "")}</p>
              </div>
              <time>${escapeHtml(formatTime(event.createdAt))}</time>
            </div>
          `
        )
        .join("")
    : `<div class="item muted">No activity yet.</div>`;
}

async function loadDashboard() {
  const settled = await Promise.allSettled([
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
  const valueAt = (index, fallback) => {
    if (settled[index].status === "fulfilled") {
      return settled[index].value;
    }
    showToast(settled[index].reason?.message || "Some dashboard data failed to load", "warning");
    return fallback;
  };
  const health = valueAt(0, { ok: false, environment: "unknown", runtimeMode: "unknown" });
  const agents = valueAt(1, { agents: [] });
  const approvals = valueAt(2, { approvals: [] });
  const tasks = valueAt(3, { tasks: [] });
  const files = valueAt(4, { files: [] });
  const actionLog = valueAt(5, { actions: [] });
  const permissions = valueAt(6, { permissionModes: [] });
  const database = valueAt(7, { database: { provider: "unknown", connected: false, note: "Unavailable" } });
  const storage = valueAt(8, { storage: { provider: "unknown", bucket: "unknown", mode: "unknown" } });
  const runtime = valueAt(9, {
    runtime: { mode: "unknown", networkPolicy: "unknown", llm: { localAiImplemented: false } },
    llmProvider: { id: "unknown", status: "unavailable", note: "Unavailable" }
  });
  const chatHistory = valueAt(10, { history: [] });

  const healthDot = document.getElementById("health-dot");
  const healthPill = document.getElementById("health-pill");
  healthDot.className = `status-dot ${health.ok ? "online" : "offline"}`;
  healthPill.textContent = health.ok ? "Runtime online" : "Runtime offline";

  document.getElementById("metric-agents").textContent = agents.agents.length;
  document.getElementById("metric-tasks").textContent = tasks.tasks.length;
  document.getElementById("metric-approvals").textContent = approvals.approvals.length;
  document.getElementById("metric-files").textContent = files.files.length;
  dashboardTasks = tasks.tasks;
  dashboardFiles = files.files;
  dashboardApprovals = approvals.approvals;
  if (actionLog.actions?.length) {
    dashboardActionLog = actionLog.actions;
  }
  const providerPill = document.getElementById("provider-pill");
  if (providerPill) {
    providerPill.textContent = `${runtime.llmProvider.id} - ${runtime.llmProvider.status}`;
    providerPill.classList.toggle("offline", runtime.llmProvider.status !== "ready" && runtime.llmProvider.status !== "mock");
  }
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
      <article class="task-record" id="task-${escapeHtml(task.id)}">
      <strong>${escapeHtml(task.title)}</strong>
      <div class="muted">${pill(task.status, task.status)} ${escapeHtml(task.assignedAgentId)}</div>
      <div class="muted">${escapeHtml(task.description || "No description")}</div>
      <div class="muted preline">${escapeHtml(latestTaskOutput(task))}</div>
      <div class="faint muted">Events: ${escapeHtml(task.history?.length || 0)}</div>
      </article>
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
  renderActivityFeed();

  renderList(
    "files-list",
    files.files.filter((file) => {
      const haystack = `${file.filename || ""} ${file.path || ""} ${file.provider || ""}`.toLowerCase();
      return haystack.includes(fileSearchTerm.toLowerCase());
    }),
    (file) => `
      <strong>${escapeHtml(file.filename || "Untitled file")}</strong>
      <div class="muted">${escapeHtml(file.path || "No path")}</div>
      <div class="muted">${escapeHtml(file.provider)} - ${escapeHtml(file.bucket)} - ${escapeHtml(file.size_bytes)} bytes</div>
      <div class="button-row">
        ${pill(file.mime_type || "file")}
        ${pill(file.task_id ? "task-linked" : "unassigned")}
      </div>
      <div class="button-row">
        <button data-file-action="read" data-file-id="${escapeHtml(file.id)}" ${can("files:read") ? "" : "disabled"}>Read</button>
        <button data-file-action="download" data-file-id="${escapeHtml(file.id)}" ${can("files:read") ? "" : "disabled"}>Download</button>
        <button data-file-action="summarize" data-file-id="${escapeHtml(file.id)}" ${can("chat:use") ? "" : "disabled"}>Summarize</button>
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
  const payload = await uploadFileObject(file, taskId);
  result.textContent = `Uploaded ${payload.file.filename} to ${payload.file.path}`;
  input.value = "";
  showToast(`Uploaded ${payload.file.filename}`, "success");
  pushActivity(`File uploaded: ${payload.file.filename}`, "file");
  await loadDashboard();
}

async function uploadFileObject(file, taskId = "") {
  const content = arrayBufferToBase64(await file.arrayBuffer());
  const response = await apiFetch("/api/files/upload", {
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
    throw new Error("Login required.");
  }
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message || payload.error || "File upload failed.");
  }
  return payload;
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

  if (action === "summarize") {
    location.hash = "#chat";
    showPage("chat");
    const file = dashboardFiles.find((item) => item.id === fileId);
    await sendChatRequest({
      message: `Summarize file ${file?.filename || fileId}`,
      file_id: fileId,
      task_id: null
    });
    return;
  }

  if (action === "delete") {
    const response = await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
    const payload = await response.json();
    result.textContent =
      payload.status === "approval_required"
        ? `Delete requires approval: ${payload.approval_id}`
        : `Deleted ${payload.file.filename}`;
    showToast(payload.status === "approval_required" ? "Approval required for delete" : "File deleted", "info");
    await loadDashboard();
  }
}

async function createDemoTask() {
  if (!can("tasks:create")) {
    return;
  }
  const response = await apiFetch("/api/tasks", {
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

  showToast("Demo task created", "success");
  pushActivity("CEO Agent created demo task", "task");
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

  const response = await apiFetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  if (!response.ok) {
    const message = await readErrorMessage(response, "CEO Agent command failed.");
    result.textContent = message;
    showToast(message, "error");
    return;
  }

  const payload = await response.json();
  result.textContent = `${payload.selected_agent?.name || "CEO Agent"} -> ${payload.status}. ${payload.response}`;
  if (payload.status_report?.kind === "task_status") {
    renderChatStatusResult(payload.status_report);
  }
  input.value = "";
  showToast(
    payload.status === "status_report" ? "CEO status ready" : payload.approval_required ? "Approval required" : "Task routed",
    payload.approval_required ? "warning" : "success"
  );
  pushActivity(`CEO Agent ${payload.status}: ${payload.selected_agent?.name || "status"}`, "agent");
  await loadDashboard();
}

async function sendChatMessage(event) {
  event.preventDefault();
  await sendChatRequest();
}

async function sendChatRequest(overrides = {}) {
  if (!can("chat:use") || isGenerating) {
    setChatStatus("blocked");
    return;
  }

  const input = document.getElementById("chat-input");
  const fileSelector = document.getElementById("chat-file-selector");
  const taskSelector = document.getElementById("chat-task-selector");
  const message = String(overrides.message ?? input.value).trim();
  const fileId = String(overrides.file_id ?? fileSelector.value).trim();
  const taskId = String(overrides.task_id ?? taskSelector.value).trim();

  if (!message && !pendingAttachmentFile) {
    setChatStatus("ready");
    return;
  }

  const isActionRequest = /\b(create|build|make|implement|generate|fix|analyze repo|write code|create document)\b/i.test(message);
  if (isActionRequest && can("agents:execute")) {
    await createTaskFromChat(message);
    return;
  }

  let attachedFileId = fileId || null;
  if (pendingAttachmentFile) {
    try {
      const upload = await uploadFileObject(pendingAttachmentFile);
      attachedFileId = upload.file.id;
      showToast(`Attached ${upload.file.filename}`, "success");
      pushActivity(`Chat Agent attached file ${upload.file.filename}`, "file");
    } catch (error) {
      showToast(error.message, "error");
      setChatStatus("error");
      return;
    }
  }

  const outgoingMessage = message || `Summarize attached file ${pendingAttachmentFile?.name || ""}`;
  appendLocalMessage("user", outgoingMessage, {
    file_id: attachedFileId,
    task_id: taskId || null
  });
  pendingAttachmentFile = null;
  renderAttachmentPreview();
  stopGeneration = false;
  setChatStatus("thinking", true);
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: outgoingMessage,
      conversation_id: activeConversationId,
      file_id: attachedFileId,
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
    showToast("Chat failed", "error");
    return;
  }

  const payload = await response.json();
  activeConversationId = payload.conversation_id;
  lastChatTaskSuggestion = payload.task_suggestions?.[0] || {
    title: "Chat follow-up",
    command: outgoingMessage
  };
  input.value = "";
  await streamAssistantMessage(payload.response);
  if (payload.status_report?.kind === "task_status") {
    renderChatStatusResult(payload.status_report);
  }
  if (payload.orchestration?.task_id) {
    renderChatTaskResult(payload.orchestration);
    showToast(`Task ${payload.orchestration.status}`, payload.orchestration.approval_required ? "warning" : "success");
  }
  pushActivity(`Chat Agent responded: ${payload.intent}`, "chat");
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

async function createTaskFromChat(commandOverride = "") {
  if (!can("chat:use") || !can("agents:execute")) {
    return;
  }
  const input = document.getElementById("chat-input");
  const draft = String(commandOverride || input.value).trim();
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
  const response = await apiFetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command,
      fast: true,
      conversation_id: activeConversationId
    })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  const payload = await response.json();
  if (!response.ok) {
    setChatStatus("error");
    renderChatError(payload.message || payload.error || "CEO Agent could not create the task.");
    return;
  }
  setChatStatus("task created");
  appendLocalMessage("user", command);
  appendLocalMessage(
    "assistant",
    [
      `CEO Agent started orchestration.`,
      `Task: ${payload.task?.title || payload.task_id}`,
      `Assigned agent: ${payload.selected_agent?.name || "Specialist agent"}`,
      `Status: ${payload.status}`,
      payload.approval_required ? `Approval required: ${payload.approval_id}` : "Execution pipeline started."
    ].join("\n"),
    { orchestration: payload }
  );
  input.value = "";
  showToast("Task created and assigned", "success");
  pushActivity(`CEO Agent created task ${payload.task_id}`, "task");
  await loadDashboard();
  renderChatTaskResult(payload);
}

function openTask(taskId = lastCreatedTaskId) {
  if (!taskId) {
    return;
  }
  location.hash = "#tasks";
  showPage("tasks");
  window.setTimeout(() => {
    const element = document.getElementById(`task-${CSS.escape(taskId)}`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
    element?.classList.add("active-task");
    window.setTimeout(() => element?.classList.remove("active-task"), 1400);
  }, 80);
}

function renderAttachmentPreview() {
  const element = document.getElementById("attachment-preview");
  if (!element) {
    return;
  }
  if (!pendingAttachmentFile) {
    element.classList.add("hidden");
    element.innerHTML = "";
    return;
  }
  element.classList.remove("hidden");
  element.innerHTML = `
    <div>
      <strong>${escapeHtml(pendingAttachmentFile.name)}</strong>
      <span>${escapeHtml(Math.ceil(pendingAttachmentFile.size / 1024))} KB ready to upload</span>
    </div>
    <button class="mini-button" type="button" data-clear-attachment>Remove</button>
  `;
}

function startNewChat() {
  activeConversationId = null;
  lastChatTaskSuggestion = null;
  renderConversationList();
  renderChatMessages(null);
  document.getElementById("chat-input").focus();
}

function renameActiveChat() {
  if (!activeConversationId) {
    return;
  }
  const currentTitle = conversationTitle(activeConversation());
  const title = window.prompt("Rename conversation", currentTitle);
  if (!title) {
    return;
  }
  conversationPreferences[activeConversationId] = {
    ...(conversationPreferences[activeConversationId] || {}),
    title: title.trim()
  };
  saveConversationPreferences();
  renderConversationList();
  showToast("Conversation renamed", "success");
}

function deleteActiveChat() {
  if (!activeConversationId) {
    return;
  }
  conversationPreferences[activeConversationId] = {
    ...(conversationPreferences[activeConversationId] || {}),
    deleted: true
  };
  saveConversationPreferences();
  activeConversationId = null;
  renderConversationList();
  renderChatMessages(null);
  showToast("Conversation hidden on this device", "info");
}

function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(
    () => showToast("Copied", "success"),
    () => showToast("Copy failed", "error")
  );
}

async function regenerateAssistantMessage(index) {
  const conversation = activeConversation();
  const messages = conversation?.messages || [];
  const previousUser = messages.slice(0, index).reverse().find((message) => message.role === "user");
  if (!previousUser) {
    showToast("No user message to regenerate from", "warning");
    return;
  }
  await sendChatRequest({ message: previousUser.content, file_id: previousUser.metadata?.file_id || null, task_id: previousUser.metadata?.task_id || null });
}

function renderTaskDrawer(task) {
  const drawer = document.getElementById("task-drawer");
  const title = document.getElementById("task-drawer-title");
  const content = document.getElementById("task-drawer-content");
  if (!drawer || !task) {
    return;
  }
  title.textContent = task.title;
  content.innerHTML = `
    <div class="task-detail-grid">
      <div>${pill(task.status, task.status)} ${pill(task.assignedAgentId || "unassigned")}</div>
      <div class="muted">Created ${escapeHtml(formatTime(task.createdAt))}</div>
      <div class="muted preline">${escapeHtml(task.description || "No description")}</div>
      <div>
        <strong>Requirements</strong>
        <ul>${(task.metadata?.requirements || ["No structured requirements yet."]).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      </div>
      <div>
        <strong>Execution logs</strong>
        <div class="stack">
          ${(task.history || [])
            .map(
              (event) => `
                <div class="item">
                  <strong>${escapeHtml(event.eventType)}</strong>
                  <div class="muted">${escapeHtml(formatTime(event.createdAt))}</div>
                  <div class="muted preline">${escapeHtml(JSON.stringify(event.payload, null, 2))}</div>
                </div>
              `
            )
            .join("") || `<div class="item muted">No execution logs yet.</div>`}
        </div>
      </div>
    </div>
  `;
  drawer.classList.remove("hidden");
}

async function login(event) {
  event.preventDefault();
  const result = document.getElementById("login-result");
  const response = await apiFetch("/api/auth/login", {
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
  await apiFetch("/api/auth/logout", { method: "POST" });
  showLogin("Logged out.");
}

async function decideApproval(event) {
  const button = event.target.closest("[data-approval-action]");
  if (!button) {
    return;
  }
  if (!can("approvals:approve")) {
    showToast("Your role does not have approval permission.", "warning");
    return;
  }

  const action = button.dataset.approvalAction;
  const approvalId = button.dataset.approvalId;
  button.disabled = true;
  button.textContent = action === "approve" ? "Approving..." : "Rejecting...";
  const response = await apiFetch(`/api/approvals/${approvalId}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decidedBy: "dashboard" })
  });
  if (response.status === 401) {
    showLogin("Login required.");
    return;
  }
  if (!response.ok) {
    const message = await readErrorMessage(response, "Approval action failed.");
    showToast(message, "error");
    button.disabled = false;
    button.textContent = action === "approve" ? "Approve" : "Reject";
    return;
  }
  showToast(action === "approve" ? "Approval granted" : "Approval rejected", "success");
  pushActivity(`Approval ${action}d`, "approval");
  await loadDashboard();
}

window.addEventListener("hashchange", () => showPage(location.hash.slice(1)));
document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
document.getElementById("login-form").addEventListener("submit", login);
document.getElementById("logout-button").addEventListener("click", logout);
document.getElementById("create-task-button").addEventListener("click", createDemoTask);
document.getElementById("command-form").addEventListener("submit", sendCommand);
document.getElementById("chat-form").addEventListener("submit", sendChatMessage);
document.getElementById("chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChatRequest();
  }
});
document.getElementById("chat-messages").addEventListener("click", (event) => {
  const copyCode = event.target.closest("[data-copy-code]");
  if (copyCode) {
    copyToClipboard(copyCode.dataset.copyCode);
    return;
  }
  const copyMessage = event.target.closest("[data-copy-message]");
  if (copyMessage) {
    const message = activeConversation()?.messages?.[Number(copyMessage.dataset.copyMessage)];
    copyToClipboard(message?.content || "");
    return;
  }
  const regenerate = event.target.closest("[data-regenerate-message]");
  if (regenerate) {
    regenerateAssistantMessage(Number(regenerate.dataset.regenerateMessage));
  }
  const example = event.target.closest("[data-example-prompt]");
  if (example) {
    document.getElementById("chat-input").value = example.dataset.examplePrompt;
    sendChatRequest();
  }
});
document.getElementById("chat-conversation-list").addEventListener("click", selectConversation);
document.getElementById("new-chat-button").addEventListener("click", startNewChat);
document.getElementById("rename-chat-button").addEventListener("click", renameActiveChat);
document.getElementById("delete-chat-button").addEventListener("click", deleteActiveChat);
document.getElementById("chat-create-task-button").addEventListener("click", createTaskFromChat);
document.getElementById("chat-task-result").addEventListener("click", (event) => {
  const button = event.target.closest("[data-open-task]");
  if (button) {
    openTask(button.dataset.openTask);
  }
});
document.getElementById("attachment-preview").addEventListener("click", (event) => {
  if (event.target.closest("[data-clear-attachment]")) {
    pendingAttachmentFile = null;
    renderAttachmentPreview();
  }
});
document.getElementById("chat-stop-button").addEventListener("click", () => {
  stopGeneration = true;
  setChatStatus("stopped");
});
document.getElementById("chat-summarize-file-button").addEventListener("click", summarizeSelectedFile);
document.getElementById("chat-explain-task-button").addEventListener("click", explainSelectedTask);
document.getElementById("approvals-list").addEventListener("click", decideApproval);
document.getElementById("home-approvals-list").addEventListener("click", decideApproval);
document.getElementById("file-upload-form").addEventListener("submit", uploadFile);
document.getElementById("files-list").addEventListener("click", handleFileAction);
document.getElementById("file-search-input").addEventListener("input", (event) => {
  fileSearchTerm = event.target.value;
  loadDashboard();
});
document.getElementById("tasks-list").addEventListener("click", (event) => {
  const record = event.target.closest(".task-record");
  if (!record) {
    return;
  }
  const taskId = record.id.replace(/^task-/, "");
  renderTaskDrawer(dashboardTasks.find((task) => task.id === taskId));
});
document.getElementById("task-drawer-close").addEventListener("click", () => {
  document.getElementById("task-drawer").classList.add("hidden");
});

  for (const target of [document.getElementById("chat-messages"), document.getElementById("chat-drop-zone")].filter(Boolean)) {
  target.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.getElementById("chat-drop-zone").classList.remove("hidden");
  });
  target.addEventListener("dragleave", () => {
    document.getElementById("chat-drop-zone").classList.add("hidden");
  });
  target.addEventListener("drop", (event) => {
    event.preventDefault();
    document.getElementById("chat-drop-zone").classList.add("hidden");
    pendingAttachmentFile = event.dataTransfer.files[0] || null;
    renderAttachmentPreview();
    if (pendingAttachmentFile) {
      showToast("Attachment ready", "info");
    }
  });
}

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

window.addEventListener("load", () => {
  window.setTimeout(() => document.getElementById("splash-screen")?.classList.add("hidden"), 450);
});

window.addEventListener("online", () => showToast("Back online", "success"));
window.addEventListener("offline", () => showToast("Offline mode detected", "warning"));
window.addEventListener("error", () => showToast("Mobile UI recovered from an interface error.", "warning"));
window.addEventListener("unhandledrejection", () => showToast("A request failed, but TerminalX is still running.", "warning"));
