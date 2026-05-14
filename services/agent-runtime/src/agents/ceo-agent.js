const { agentRegistry } = require("./registry");
const { buildSpecialistResponse } = require("./specialists");

const intentRules = [
  {
    intent: "trading",
    agentType: "trading",
    keywords: ["trade", "trading", "stock", "crypto", "forex", "buy", "sell", "portfolio", "market", "btc", "eth"]
  },
  {
    intent: "testing",
    agentType: "testing",
    keywords: ["test", "tests", "qa", "verify", "validate", "regression", "coverage", "bug"]
  },
  {
    intent: "coding",
    agentType: "coding",
    keywords: ["code", "build", "create", "make", "implement", "fix", "refactor", "api", "app", "calculator", "backend", "frontend", "database", "component"]
  },
  {
    intent: "content",
    agentType: "content",
    keywords: ["write", "draft", "blog", "post", "copy", "docs", "readme", "article", "content", "tweet", "caption", "script", "ideas"]
  }
];

const riskyRules = [
  {
    riskLevel: "critical",
    approvalType: "trading_execution",
    keywords: ["live trade", "place order", "buy now", "sell now", "execute trade", "real money"]
  },
  {
    riskLevel: "critical",
    approvalType: "file_deletion",
    keywords: ["delete file", "delete files", "remove file", "remove files"]
  },
  {
    riskLevel: "critical",
    approvalType: "destructive_shell_command",
    keywords: ["rm -rf", "reset hard", "force push", "remove-item", "rmdir"]
  },
  {
    riskLevel: "high",
    approvalType: "database_migration",
    keywords: ["database migration", "db migration", "migrate database", "drop database", "db:migrate"]
  },
  {
    riskLevel: "high",
    approvalType: "production_deploy",
    keywords: ["production deploy", "deploy production", "deploy --prod", "deploy to prod"]
  },
  {
    riskLevel: "medium",
    approvalType: "external_posting",
    keywords: ["publish", "send email", "post online", "tweet", "post to social"]
  }
];

function findAgentByType(type) {
  return agentRegistry.find((agent) => agent.type === type) || agentRegistry.find((agent) => agent.type === "chat");
}

function classifyIntent(command) {
  const normalized = command.toLowerCase();

  for (const rule of intentRules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return {
        intent: rule.intent,
        agent: findAgentByType(rule.agentType)
      };
    }
  }

  return {
    intent: "chat",
    agent: findAgentByType("chat")
  };
}

async function classifyIntentWithAi(command, llmProvider) {
  if (!llmProvider?.classifyIntent) {
    return {
      ...classifyIntent(command),
      classifier: "rules"
    };
  }

  try {
    const result = await llmProvider.classifyIntent(command);
    const agent = findAgentByType(result.intent);
    return {
      intent: result.intent,
      agent,
      classifier: result.provider || "ai"
    };
  } catch {
    return {
      ...classifyIntent(command),
      classifier: "rules_fallback"
    };
  }
}

function evaluateRisk(command, selectedAgent) {
  const normalized = command.toLowerCase();

  for (const rule of riskyRules) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return {
        approvalRequired: true,
        riskLevel: rule.riskLevel,
        approvalType: rule.approvalType,
        reason: `Matched risky action policy: ${rule.approvalType}`
      };
    }
  }

  if (selectedAgent.type === "trading" && normalized.includes("order")) {
    return {
      approvalRequired: true,
      riskLevel: "high",
      approvalType: "trading_order",
      reason: "Trading orders require approval before execution."
    };
  }

  return {
    approvalRequired: false,
    riskLevel: "low",
    approvalType: null,
    reason: "No risky action policy matched."
  };
}

function buildTaskPayload(command, classification, risk) {
  const codingBuildTask = buildCodingBuildTask(command, classification);
  const executionPlan = buildExecutionPlan(command, classification, codingBuildTask?.metadata?.requirements || []);
  const metadata = {
    ...(codingBuildTask?.metadata || {}),
    execution_plan: executionPlan,
    priority: inferPriority(command)
  };

  return {
    title: codingBuildTask?.title || `${classification.agent.name}: ${command.slice(0, 80)}`,
    description: codingBuildTask?.description || command,
    status: codingBuildTask?.status,
    assignedAgentId: classification.agent.id,
    intent: classification.intent,
    approvalRequired: risk.approvalRequired,
    riskLevel: risk.riskLevel,
    metadata
  };
}

function normalizeExecutionMode(value) {
  const normalized = String(value || "").toLowerCase();
  if (["plan", "plan_mode", "planning"].includes(normalized)) {
    return "plan";
  }
  return "execution";
}

function inferPriority(command) {
  return /\b(urgent|asap|now|critical|production)\b/i.test(command) ? "high" : "normal";
}

function buildExecutionPlan(command, classification, requirements = []) {
  const baseSteps = [
    "CEO Agent classified intent and selected specialist agent",
    `Create structured task for ${classification.agent.name}`,
    `${classification.agent.name} receives task context and requirements`,
    `${classification.agent.name} executes safe workflow and records logs`,
    "Approval queue pauses any risky or file-writing action",
    "Task history is updated for the dashboard activity feed"
  ];

  if (classification.agent.type === "coding") {
    return [
      ...baseSteps,
      "Coding Agent drafts implementation files or change plan",
      "Testing Agent can validate generated output after approval"
    ];
  }

  if (requirements.length) {
    return [...baseSteps, ...requirements.map((item) => `Requirement: ${item}`)];
  }
  return baseSteps;
}

function titleCase(value) {
  return String(value || "")
    .replace(/[^\w\s-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function isCodingBuildRequest(command, classification) {
  if (classification.intent !== "coding" || classification.agent.type !== "coding") {
    return false;
  }
  return /\b(build|create|make|implement)\b/i.test(command);
}

function buildRequirements(command) {
  if (/\bcalculator\b/i.test(command)) {
    return [
      "CLI calculator",
      "add/subtract/multiply/divide",
      "input validation",
      "tests"
    ];
  }

  return [
    "Clarify target runtime and user workflow",
    "Create a minimal working implementation",
    "Add input validation and error handling",
    "Add or update focused tests"
  ];
}

function buildCodingTitle(command) {
  const normalized = String(command || "")
    .replace(/\b(please|can you|could you|i want|to)\b/gi, " ")
    .replace(/\b(build|create|make|implement)\b/gi, " ")
    .replace(/\b(basic|new|a|an|the|for me)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `Build ${titleCase(normalized || "Coding Task")}`;
}

function buildCodingBuildTask(command, classification) {
  if (!isCodingBuildRequest(command, classification)) {
    return null;
  }

  const requirements = buildRequirements(command);
  return {
    title: buildCodingTitle(command),
    status: "created",
    description: [`User request: ${command}`, "Requirements:", ...requirements.map((item) => `- ${item}`)].join("\n"),
    metadata: {
      requirements,
      task_kind: "coding_build",
      next_agent_action: "Coding Agent can inspect requirements and propose file changes. File writes still require approval."
    }
  };
}

function createApprovalForTask({ task, agent, command, risk, approvalQueue }) {
  const approval = {
    title: `Approve ${risk.approvalType} for ${agent.name}`,
    taskId: task.id,
    requestedBy: "ceo-agent",
    assignedAgentId: agent.id,
    approvalType: risk.approvalType,
    riskLevel: risk.riskLevel,
    description: `CEO Agent blocked this command until approval: ${command}`,
    proposedAction: {
      command,
      agentType: agent.type,
      reason: risk.reason
    }
  };

  return approvalQueue.add(approval);
}

function createExecutionApproval({ task, agent, command, approvalQueue }) {
  return approvalQueue.add({
    title: `Approve execution for ${agent.name}`,
    taskId: task.id,
    requestedBy: "ceo-agent",
    assignedAgentId: agent.id,
    approvalType: "execute_plan",
    riskLevel: "medium",
    description: `Plan mode created this task and is waiting for approval before execution: ${command}`,
    proposedAction: {
      command,
      agentType: agent.type,
      executionPlan: task.metadata?.execution_plan || []
    }
  });
}

function handleCommand({ command, createTask, approvalQueue }) {
  const trimmedCommand = String(command || "").trim();
  if (!trimmedCommand) {
    throw new Error("command is required");
  }

  const classification = classifyIntent(trimmedCommand);
  const risk = evaluateRisk(trimmedCommand, classification.agent);
  const task = createTask(buildTaskPayload(trimmedCommand, classification, risk));

  if (risk.approvalRequired) {
    const approval = createApprovalForTask({
      task,
      agent: classification.agent,
      command: trimmedCommand,
      risk,
      approvalQueue
    });

    return {
      selected_agent: classification.agent,
      task_id: task.id,
      status: "approval_required",
      response: `CEO Agent routed this to ${classification.agent.name}, but approval is required before execution.`,
      approval_required: true,
      approval_id: approval.id
    };
  }

  const specialistResponse = buildSpecialistResponse(classification.agent, task, trimmedCommand);

  return {
    selected_agent: classification.agent,
    task_id: task.id,
    status: "sent",
    response: specialistResponse.message,
    approval_required: false
  };
}

async function handleCommandWithAi({ command, createTask, approvalQueue, llmProvider, orchestrator, executionMode = "execution" }) {
  const trimmedCommand = String(command || "").trim();
  if (!trimmedCommand) {
    throw new Error("command is required");
  }

  const classification = await classifyIntentWithAi(trimmedCommand, llmProvider);
  const risk = evaluateRisk(trimmedCommand, classification.agent);
  if (
    classification.intent === "chat" &&
    /\b(status|what is going on|what's going on|current status|all agents|pending approvals|running tasks|what is happening)\b/i.test(trimmedCommand)
  ) {
    return {
      selected_agent: classification.agent,
      task_id: null,
      status: "status_request",
      response: "CEO Agent status requests are answered from the Chat page status report and dashboard activity feed. No new task was required.",
      approval_required: false,
      classifier: classification.classifier
    };
  }
  const taskPayload = buildTaskPayload(trimmedCommand, classification, risk);
  const mode = normalizeExecutionMode(executionMode);
  const task = createTask({
    ...taskPayload,
    status: mode === "plan" ? "planned" : taskPayload.status,
    metadata: {
      ...taskPayload.metadata,
      classifier: classification.classifier,
      execution_mode: mode,
      supervisor: "ceo-agent"
    }
  });

  if (mode === "plan") {
    const approval = createExecutionApproval({
      task,
      agent: classification.agent,
      command: trimmedCommand,
      approvalQueue
    });
    return {
      selected_agent: classification.agent,
      task_id: task.id,
      status: "planned",
      response: `CEO Agent created an execution plan for ${classification.agent.name}. Approval is required before execution.`,
      approval_required: true,
      approval_id: approval.id,
      task,
      requirements: task.metadata?.requirements || [],
      execution_plan: task.metadata?.execution_plan || [],
      classifier: classification.classifier
    };
  }

  if (risk.approvalRequired) {
    const approval = createApprovalForTask({
      task,
      agent: classification.agent,
      command: trimmedCommand,
      risk,
      approvalQueue
    });
    await orchestrator?.execute?.({
      taskId: task.id,
      agent: classification.agent,
      command: trimmedCommand,
      approvalRequired: true,
      approvalId: approval.id
    });

    return {
      selected_agent: classification.agent,
      task_id: task.id,
      status: "waiting_approval",
      response: `CEO Agent routed this to ${classification.agent.name}, but approval is required before execution.`,
      approval_required: true,
      approval_id: approval.id,
      classifier: classification.classifier
    };
  }

  if (orchestrator?.execute) {
    const execution = await orchestrator.execute({
      taskId: task.id,
      agent: classification.agent,
      command: trimmedCommand
    });

    return {
      selected_agent: classification.agent,
      task_id: task.id,
      status: execution.status,
      response: execution.response,
      approval_required: execution.approval_required,
      approval_id: execution.approval_id,
      result: execution.result,
      task,
      requirements: task.metadata?.requirements || [],
      execution_plan: task.metadata?.execution_plan || [],
      classifier: classification.classifier
    };
  }

  const specialistResponse = buildSpecialistResponse(classification.agent, task, trimmedCommand);

  return {
    selected_agent: classification.agent,
    task_id: task.id,
    status: "sent",
    response: specialistResponse.message,
    approval_required: false,
    classifier: classification.classifier
  };
}

module.exports = {
  classifyIntent,
  classifyIntentWithAi,
  evaluateRisk,
  handleCommand,
  handleCommandWithAi
};
