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

  if (payload.task_id || normalized.includes("explain task") || normalized.includes("task status")) {
    return "explain_task";
  }

  if (/\b(status|what is going on|what's going on|current status|all agents|pending approvals|running tasks|what is happening)\b/i.test(normalized)) {
    return "system_status";
  }

  if (/\b(create|build|make|implement|generate|fix|analyze repo|write code|create document)\b/i.test(normalized)) {
    return "action_request";
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

function buildSystemStatus(snapshot = {}) {
  const agents = snapshot.agents || [];
  const tasks = snapshot.tasks || [];
  const approvals = snapshot.approvals || [];
  const runningTasks = tasks.filter((task) => ["running", "assigned", "waiting_approval", "planned"].includes(task.status));
  const recentTasks = tasks.slice(0, 5);

  return [
    "CEO Agent status report:",
    `- Agents online: ${agents.length || "unknown"}`,
    `- Total tasks: ${tasks.length}`,
    `- Active/running tasks: ${runningTasks.length}`,
    `- Pending approvals: ${approvals.length}`,
    "",
    "Recent tasks:",
    ...(recentTasks.length
      ? recentTasks.map((task) => `- ${task.title} | ${task.status} | ${task.assignedAgentId || "unassigned"}`)
      : ["- No tasks yet."]),
    "",
    approvals.length
      ? `Next action: review ${approvals.length} pending approval(s) in the Approvals page.`
      : "Next action: no approvals are currently blocking execution."
  ].join("\n");
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
    if (intent === "summarize_file") {
      response = await summarizeFile(payload.file_id, storageService);
    } else if (intent === "explain_task") {
      response = explainTask(findTask(payload.task_id));
    } else if (intent === "system_status") {
      response = buildSystemStatus(typeof getSystemStatus === "function" ? getSystemStatus() : {});
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
      orchestration
    });

    return {
      agent: "chat-agent",
      conversation_id: conversation.id,
      intent,
      response,
      task_suggestions: taskSuggestions,
      orchestration,
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

module.exports = { createChatAgent };
