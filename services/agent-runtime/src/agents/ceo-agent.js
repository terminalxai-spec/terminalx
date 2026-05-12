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
    keywords: ["code", "build", "implement", "fix", "refactor", "api", "backend", "frontend", "database", "component"]
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
  return {
    title: `${classification.agent.name}: ${command.slice(0, 80)}`,
    description: command,
    assignedAgentId: classification.agent.id,
    intent: classification.intent,
    approvalRequired: risk.approvalRequired,
    riskLevel: risk.riskLevel
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

async function handleCommandWithAi({ command, createTask, approvalQueue, llmProvider, orchestrator }) {
  const trimmedCommand = String(command || "").trim();
  if (!trimmedCommand) {
    throw new Error("command is required");
  }

  const classification = await classifyIntentWithAi(trimmedCommand, llmProvider);
  const risk = evaluateRisk(trimmedCommand, classification.agent);
  const task = createTask({
    ...buildTaskPayload(trimmedCommand, classification, risk),
    metadata: {
      classifier: classification.classifier
    }
  });

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
