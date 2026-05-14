function nowIso() {
  return new Date().toISOString();
}

function previewText(value, limit = 1200) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function summarizeText(content) {
  const text = String(content || "");
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const sentences = text
    .split(/[.!?]\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return {
    words,
    lines,
    summary:
      sentences.slice(0, 3).join(". ") ||
      "This file is empty or does not contain readable text.",
    preview: previewText(text, 700)
  };
}

function classifyChatIntent(message, payload = {}) {
  const normalized = String(message || "").toLowerCase();

  if (payload.file_id || normalized.includes("summarize file") || normalized.includes("summarise file")) {
    return "summarize_file";
  }

  if (payload.task_id || normalized.includes("explain task")) {
    return "explain_task";
  }

  if (/\b(create|build|make|implement|generate|fix|analyze repo|write code|create document)\b/i.test(normalized)) {
    return "action_request";
  }

  if (/\b(approval|approve|pending approval|pending approvals|blocked|waiting approval|human gate)\b/i.test(normalized)) {
    return "approval_query";
  }

  if (/\b(file|files|upload|uploaded|storage|document|documents)\b/i.test(normalized) && /\b(status|list|show|where|find|what)\b/i.test(normalized)) {
    return "file_query";
  }

  if (/\b(agent|agents|ceo|coding agent|testing agent|content agent|trading agent|chat agent)\b/i.test(normalized) && /\b(status|online|available|ready|current|working)\b/i.test(normalized)) {
    return "agent_status";
  }

  if (/\b(task status|status of|progress of|where is|what happened to|current status of|how is|open task|show task)\b/i.test(normalized)) {
    return "task_status";
  }

  if (/\b(status|what is going on|what's going on|current status|running tasks|what is happening|what's happening)\b/i.test(normalized)) {
    return "system_status";
  }

  if (normalized.includes("plan") || normalized.includes("roadmap") || normalized.includes("steps")) {
    return "plan_work";
  }

  return "general_question";
}

function buildPlan(message) {
  return [
    `Goal: ${message}`,
    "1. Clarify the desired outcome and constraints.",
    "2. Break the work into a small task record.",
    "3. Route implementation to the right specialist agent.",
    "4. Use the approval queue for risky actions.",
    "5. Verify results and store outputs in task history."
  ].join("\n");
}

function buildTaskSuggestions(message, intent) {
  if (!["plan_work", "action_request"].includes(intent)) {
    return [];
  }

  return [
    {
      title: "Chat planning follow-up",
      command: `Create a TerminalX task plan for: ${message}`,
      target_agent: "ceo-agent"
    }
  ];
}

function explainTask(task) {
  if (!task) {
    return "I could not find that task. Share a valid task id and I can explain its status, owner, and history.";
  }

  const historyCount = task.history?.length || 0;
  return [
    `Task ${task.id}: ${task.title}`,
    `Status: ${task.status}`,
    `Assigned agent: ${task.assignedAgentId}`,
    `Intent: ${task.intent || "not classified"}`,
    `Risk: ${task.riskLevel}`,
    `History events: ${historyCount}`,
    `Description: ${task.description || "No description"}`
  ].join("\n");
}

const TASK_SEARCH_STOPWORDS = new Set([
  "a",
  "all",
  "and",
  "app",
  "application",
  "ceo",
  "current",
  "for",
  "get",
  "give",
  "how",
  "is",
  "me",
  "my",
  "of",
  "on",
  "please",
  "progress",
  "project",
  "show",
  "status",
  "task",
  "tasks",
  "tell",
  "the",
  "this",
  "to",
  "update",
  "what",
  "where"
]);

const TASK_STATUSES = ["created", "planned", "assigned", "running", "waiting_approval", "completed", "failed"];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskSearchText(task) {
  const metadata = task.metadata || {};
  return normalizeText([
    task.title,
    task.description,
    task.assignedAgentId,
    task.intent,
    task.status,
    Array.isArray(metadata.requirements) ? metadata.requirements.join(" ") : metadata.requirements,
    metadata.task_kind
  ].join(" "));
}

function extractTaskKeyword(message) {
  const normalized = normalizeText(message)
    .replace(/\b(status of|current status of|progress of|where is|what happened to|show task|open task|task status|how is)\b/g, " ");
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !TASK_SEARCH_STOPWORDS.has(token));
  return tokens.join(" ").trim();
}

function scoreTask(task, query) {
  const normalizedQuery = normalizeText(query);
  const haystack = taskSearchText(task);
  const title = normalizeText(task.title);
  const description = normalizeText(task.description);
  const requirements = normalizeText(Array.isArray(task.metadata?.requirements) ? task.metadata.requirements.join(" ") : task.metadata?.requirements);
  const agent = normalizeText(task.assignedAgentId);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  if (!tokens.length) {
    return 0;
  }

  let score = haystack.includes(normalizedQuery) ? 10 : 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 5;
    if (requirements.includes(token)) score += 4;
    if (description.includes(token)) score += 2;
    if (agent.includes(token)) score += 1;
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function searchTasks(tasks = [], query = "") {
  const cleanQuery = extractTaskKeyword(query) || normalizeText(query);
  return tasks
    .map((task) => ({ task, score: scoreTask(task, cleanQuery) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Date.parse(b.task.updatedAt || b.task.createdAt || 0) - Date.parse(a.task.updatedAt || a.task.createdAt || 0);
    });
}

function uniqueRecentTasks(tasks = [], limit = 5) {
  const seen = new Set();
  const result = [];
  for (const task of tasks) {
    const key = [normalizeText(task.title), task.assignedAgentId || "unassigned"].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(task);
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

function pendingApprovalForTask(task, approvals = []) {
  const title = normalizeText(task.title);
  return approvals.find((approval) => {
    if (approval.taskId && approval.taskId === task.id) return true;
    if (approval.task_id && approval.task_id === task.id) return true;
    const approvalText = normalizeText([approval.title, approval.description, approval.proposedAction].join(" "));
    return title && approvalText.includes(title);
  }) || null;
}

function nextActionForTask(task, approval) {
  if (approval) {
    return "Approval required before the assigned agent can continue.";
  }
  if (task.status === "waiting_approval") {
    return "Review the Approvals page and approve or reject the pending action.";
  }
  if (["created", "planned", "assigned"].includes(task.status)) {
    return "The task is queued for the assigned agent. Ask CEO to continue execution when ready.";
  }
  if (task.status === "running") {
    return "The assigned agent is still running. Check task history for the latest event.";
  }
  if (task.status === "completed") {
    return "Review the task output. No blocking approval is pending.";
  }
  if (task.status === "failed") {
    return "Ask CEO Agent to inspect the failure and reroute or retry the task.";
  }
  return "No next action is required right now.";
}

function taskDetail(task, approvals = []) {
  const approval = pendingApprovalForTask(task, approvals);
  return {
    id: task.id,
    title: task.title,
    assigned_agent: task.assignedAgentId || "unassigned",
    current_status: approval ? "waiting_approval" : task.status,
    last_update: task.updatedAt || task.createdAt || null,
    pending_approval: approval
      ? {
          id: approval.id,
          title: approval.title,
          type: approval.approvalType || approval.approval_type,
          risk: approval.riskLevel || approval.risk_level,
          status: approval.status
        }
      : null,
    next_action: nextActionForTask(task, approval),
    description: task.description || ""
  };
}

function formatTaskDetail(detail) {
  return [
    `Task title: ${detail.title}`,
    `Assigned agent: ${detail.assigned_agent}`,
    `Current status: ${detail.current_status}`,
    `Last update: ${detail.last_update || "unknown"}`,
    `Pending approval: ${detail.pending_approval ? `${detail.pending_approval.title} (${detail.pending_approval.status})` : "none"}`,
    `Next action: ${detail.next_action}`
  ].join("\n");
}

function buildTaskStatus(snapshot = {}, message = "") {
  const tasks = snapshot.tasks || [];
  const approvals = snapshot.approvals || [];
  const keyword = extractTaskKeyword(message);
  const matches = searchTasks(tasks, message).map((entry) => entry.task);

  if (!matches.length) {
    return {
      kind: "task_status",
      query: keyword,
      matches: [],
      response: keyword
        ? `I could not find a task matching "${keyword}". Try the exact task title or open the Tasks page.`
        : "I could not detect which task you want. Ask for something like: status of calculator app."
    };
  }

  const details = matches.slice(0, 3).map((task) => taskDetail(task, approvals));
  return {
    kind: "task_status",
    query: keyword,
    task: details[0],
    matches: details,
    response: [
      `CEO Agent found ${details.length === 1 ? "this matching task" : `${details.length} matching tasks`}:`,
      "",
      ...details.map(formatTaskDetail)
    ].join("\n\n")
  };
}

function buildAgentStatus(snapshot = {}) {
  const agents = snapshot.agents || [];
  const tasks = snapshot.tasks || [];
  const byAgent = new Map();
  for (const task of tasks) {
    const key = task.assignedAgentId || "unassigned";
    byAgent.set(key, {
      total: (byAgent.get(key)?.total || 0) + 1,
      active: (byAgent.get(key)?.active || 0) + (["created", "planned", "assigned", "running", "waiting_approval"].includes(task.status) ? 1 : 0)
    });
  }

  const response = [
    "CEO Agent agent status report:",
    "",
    ...(agents.length
      ? agents.map((agent) => {
          const counts = byAgent.get(agent.id) || { total: 0, active: 0 };
          return `- ${agent.name}: ${agent.status || "available"} | active tasks ${counts.active} | total tasks ${counts.total}`;
        })
      : ["- No registered agents found."])
  ].join("\n");

  return { kind: "agent_status", agents, response };
}

function buildApprovalStatus(snapshot = {}, message = "") {
  const approvals = snapshot.approvals || [];
  const matches = extractTaskKeyword(message)
    ? approvals.filter((approval) => normalizeText([approval.title, approval.description, approval.approvalType].join(" ")).includes(extractTaskKeyword(message)))
    : approvals;

  return {
    kind: "approval_status",
    approvals: matches,
    response: [
      "CEO Agent approval status:",
      ...(matches.length
        ? matches.map((approval) => `- ${approval.title} | ${approval.status} | ${approval.approvalType || approval.approval_type || "approval"} | ${approval.riskLevel || approval.risk_level || "risk unknown"}`)
        : ["- No pending approvals match this request."])
    ].join("\n")
  };
}

function buildFileStatus(snapshot = {}, message = "") {
  const files = snapshot.files || [];
  const query = extractTaskKeyword(message);
  const matches = query
    ? files.filter((file) => normalizeText([file.filename, file.path, file.provider, file.mime_type].join(" ")).includes(query))
    : files.slice(0, 10);

  return {
    kind: "file_status",
    files: matches,
    response: [
      "CEO Agent file status:",
      ...(matches.length
        ? matches.slice(0, 10).map((file) => `- ${file.filename || file.id} | ${file.provider || file.storage_provider || "storage"} | ${file.size_bytes || file.size || 0} bytes`)
        : ["- No files match this request."])
    ].join("\n")
  };
}

function buildSystemStatus(snapshot = {}) {
  const agents = snapshot.agents || [];
  const tasks = snapshot.tasks || [];
  const approvals = snapshot.approvals || [];
  const uniqueTasks = uniqueRecentTasks(tasks, 5);
  const grouped = TASK_STATUSES.map((status) => ({
    status,
    count: tasks.filter((task) => task.status === status).length
  }));

  const response = [
    "CEO Agent status report:",
    `- Agents online: ${agents.length || "unknown"}`,
    `- Total tasks: ${tasks.length}`,
    `- Pending approvals: ${approvals.length}`,
    "",
    "Tasks by status:",
    ...grouped.map((entry) => `- ${entry.status}: ${entry.count}`),
    "",
    "Latest unique tasks:",
    ...(uniqueTasks.length
      ? uniqueTasks.map((task) => `- ${task.title} | ${task.status} | ${task.assignedAgentId || "unassigned"}`)
      : ["- No tasks yet."]),
    "",
    approvals.length
      ? `Pending approvals: ${approvals.map((approval) => approval.title).slice(0, 3).join("; ")}`
      : "Pending approvals: none",
    approvals.length
      ? `Next action: review ${approvals.length} pending approval(s) in the Approvals page.`
      : "Next action: no approvals are currently blocking execution."
  ].join("\n");

  return {
    kind: "system_status",
    grouped,
    recent_tasks: uniqueTasks,
    pending_approvals: approvals,
    response
  };
}

function buildStatusReportForMessage(message, snapshot = {}) {
  const intent = classifyChatIntent(message);
  if (intent === "task_status") return buildTaskStatus(snapshot, message);
  if (intent === "agent_status") return buildAgentStatus(snapshot);
  if (intent === "approval_query") return buildApprovalStatus(snapshot, message);
  if (intent === "file_query") return buildFileStatus(snapshot, message);
  if (intent === "system_status") return buildSystemStatus(snapshot);
  return null;
}

async function summarizeFile(fileId, storageService) {
  if (!fileId) {
    return "Share a file_id and I can summarize the uploaded file.";
  }

  const stored = await storageService.read(fileId);
  if (!stored) {
    return `I could not find uploaded file ${fileId}.`;
  }

  const summary = summarizeText(stored.content);
  return [
    `File: ${stored.file.filename}`,
    `Path: ${stored.file.path}`,
    `Size: ${stored.file.size_bytes} bytes`,
    `Lines: ${summary.lines}`,
    `Words: ${summary.words}`,
    `Summary: ${summary.summary}`,
    `Preview: ${summary.preview}`
  ].join("\n");
}

function answerGeneralQuestion(message) {
  return [
    "I am the TerminalX Chat Agent.",
    "I can answer general questions, summarize uploaded files, explain tasks, and help plan work.",
    `For this request, I would start by routing or planning around: ${message}`
  ].join("\n");
}

function providerFallbackNotice(error) {
  const message = String(error?.message || "");
  if (/401|403|invalid|api.?key|unauthorized|forbidden/i.test(message)) {
    return "Cloud AI provider is unavailable because its API key was rejected. I switched to TerminalX fallback mode so you can keep working.";
  }
  if (/timed out|timeout|network|fetch/i.test(message)) {
    return "Cloud AI provider was too slow or unreachable. I switched to TerminalX fallback mode so you can keep working.";
  }
  return "Cloud AI provider is unavailable. I switched to TerminalX fallback mode so you can keep working.";
}

async function answerWithLlm({ message, intent, llmProvider }) {
  if (!llmProvider?.sendMessage) {
    return null;
  }

  const timeoutMs = Number(process.env.CHAT_LLM_TIMEOUT_MS || process.env.LLM_TIMEOUT_MS || 8000);
  const maxTokens = Number(process.env.CHAT_MAX_TOKENS || 500);

  try {
    const result = await llmProvider.sendMessage({
      system: [
        "You are TerminalX Chat Agent inside a multi-agent operating system.",
        "Answer clearly and practically.",
        "If the user asks for work to be done, suggest how the CEO Agent should route it.",
        "Do not claim that files were modified unless a tool result says so."
      ].join(" "),
      message: [`Intent: ${intent}`, `User: ${message}`].join("\n"),
      temperature: 0.3,
      maxTokens,
      timeoutMs
    });

    return result.text;
  } catch (error) {
    return [
      answerGeneralQuestion(message),
      "",
      providerFallbackNotice(error)
    ].join("\n");
  }
}

function createChatAgent({
  conversations,
  conversationRepository = null,
  storageService,
  findTask,
  llmProvider = null,
  orchestrateAction = null,
  getSystemStatus = null
}) {
  function getOrCreateConversation(conversationId) {
    const id = conversationId || `chat_${Date.now()}`;
    if (conversationRepository) {
      return (
        conversationRepository.listConversations(id) || {
          id,
          agentId: "chat-agent",
          messages: [],
          createdAt: nowIso(),
          updatedAt: nowIso()
        }
      );
    }

    if (!conversations.has(id)) {
      conversations.set(id, {
        id,
        agentId: "chat-agent",
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
    }
    return conversations.get(id);
  }

  function appendMessage(conversation, role, content, metadata = {}) {
    if (conversationRepository) {
      const message = conversationRepository.appendChatMessage({
        conversationId: conversation.id,
        agentId: conversation.agentId || "chat-agent",
        role,
        content,
        metadata
      });
      conversation.messages.push({
        id: message.id,
        role,
        content,
        metadata,
        createdAt: message.createdAt
      });
      conversation.updatedAt = message.createdAt;
      return message;
    }

    const message = {
      id: `msg_${Date.now()}_${conversation.messages.length + 1}`,
      role,
      content,
      metadata,
      createdAt: nowIso()
    };
    conversation.messages.push(message);
    conversation.updatedAt = message.createdAt;
    return message;
  }

  async function respond(payload = {}) {
    const message = String(payload.message || "").trim();
    if (!message) {
      throw new Error("message is required");
    }

    const conversation = getOrCreateConversation(payload.conversation_id);
    const intent = classifyChatIntent(message, payload);
    appendMessage(conversation, "user", message, {
      file_id: payload.file_id || null,
      task_id: payload.task_id || null,
      intent
    });

    let response;
    let orchestration = null;
    let statusReport = null;
    if (intent === "summarize_file") {
      response = await summarizeFile(payload.file_id, storageService);
    } else if (intent === "explain_task") {
      response = explainTask(findTask(payload.task_id));
    } else if (["task_status", "agent_status", "approval_query", "file_query", "system_status"].includes(intent)) {
      statusReport = buildStatusReportForMessage(message, typeof getSystemStatus === "function" ? getSystemStatus() : {});
      response = statusReport.response;
    } else if (intent === "action_request" && typeof orchestrateAction === "function") {
      orchestration = await orchestrateAction({
        command: message,
        executionMode: payload.execution_mode || payload.executionMode || "execution",
        conversationId: conversation.id
      });
      response = [
        `CEO Agent accepted the request and assigned ${orchestration.selected_agent?.name || "a specialist agent"}.`,
        `Task: ${orchestration.task?.title || orchestration.task_id}`,
        `Status: ${orchestration.status}`,
        orchestration.approval_required ? `Approval required: ${orchestration.approval_id}` : "Execution pipeline started."
      ].join("\n");
    } else if (intent === "plan_work") {
      response = await answerWithLlm({ message, intent, llmProvider }) || buildPlan(message);
    } else {
      response = await answerWithLlm({ message, intent, llmProvider }) || answerGeneralQuestion(message);
    }

    const taskSuggestions = buildTaskSuggestions(message, intent);
    appendMessage(conversation, "assistant", response, {
      intent,
      task_suggestions: taskSuggestions,
      orchestration,
      status_report: statusReport
    });

    return {
      agent: "chat-agent",
      conversation_id: conversation.id,
      intent,
      response,
      task_suggestions: taskSuggestions,
      orchestration,
      status_report: statusReport,
      task_status: statusReport?.kind === "task_status" ? statusReport.task : null,
      history_count: conversation.messages.length
    };
  }

  function history(conversationId) {
    if (conversationRepository) {
      if (conversationId) {
        return (
          conversationRepository.listConversations(conversationId) || {
            id: conversationId,
            agentId: "chat-agent",
            messages: [],
            createdAt: nowIso(),
            updatedAt: nowIso()
          }
        );
      }
      return conversationRepository.listConversations();
    }

    if (conversationId) {
      return getOrCreateConversation(conversationId);
    }
    return Array.from(conversations.values());
  }

  return {
    history,
    respond
  };
}

module.exports = {
  buildStatusReportForMessage,
  buildSystemStatus,
  buildTaskStatus,
  classifyChatIntent,
  createChatAgent,
  extractTaskKeyword,
  searchTasks,
  uniqueRecentTasks
};
