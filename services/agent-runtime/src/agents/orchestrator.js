const codingAgent = require("./coding-agent");
const contentAgent = require("./content-agent");
const testingAgent = require("./testing-agent");
const tradingAgent = require("./trading-agent");

const TASK_STATUSES = Object.freeze({
  CREATED: "created",
  PLANNED: "planned",
  ASSIGNED: "assigned",
  RUNNING: "running",
  WAITING_APPROVAL: "waiting_approval",
  COMPLETED: "completed",
  FAILED: "failed"
});

function preview(value, limit = 1400) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function updateStatus(repository, taskId, status, metadata = {}) {
  const task = repository.updateTaskStatus?.(taskId, status, metadata) || repository.findTask(taskId);
  repository.appendTaskHistory?.(taskId, `task.${status}`, {
    status,
    metadata,
    updated_by: "agent-orchestrator"
  });
  return task;
}

function latestApprovalId(result) {
  return result?.approval_id || result?.result?.approval_id || null;
}

function requiresApproval(result) {
  return Boolean(result?.approval_required || result?.result?.approval_required || result?.status === "approval_required");
}

function commandFilePath(command) {
  const match = String(command || "").match(/(?:file|path)\s+([^\s]+)/i);
  return match?.[1] || "";
}

async function executeCodingTask({ task, command, approvalQueue }) {
  const targetPath = commandFilePath(command);
  if (targetPath && /\b(read|open|show|inspect)\b/i.test(command)) {
    return codingAgent.readFile({ path: targetPath });
  }

  if (task.metadata?.task_kind === "coding_build" || /\b(build|create|make|implement)\b/i.test(command)) {
    return codingAgent.executeAssignedTask({
      task,
      command,
      approvalQueue
    });
  }

  return codingAgent.suggestChange({
    path: targetPath || "unspecified",
    instructions: command,
    currentContent: ""
  });
}

async function executeTaskByAgent({ agent, task, command, context }) {
  switch (agent.type) {
    case "chat":
      return context.chatAgent.respond({
        message: command,
        task_id: task.id
      });
    case "content":
      return contentAgent.runContentAction({
        action: "draft",
        topic: command,
        task_id: task.id
      }, context.approvalQueue);
    case "trading":
      return tradingAgent.runTradingAction({
        action: "analyze",
        symbol: context.defaultTradingSymbol || "BTC",
        task_id: task.id
      });
    case "testing":
      return testingAgent.runTests({
        task_id: task.id,
        workspace_root: context.workspaceRoot
      }, {
        approvalQueue: context.approvalQueue,
        appendTaskHistory: context.repository.appendTaskHistory?.bind(context.repository),
        createTask: context.repository.createTask?.bind(context.repository)
      });
    case "coding":
      return executeCodingTask({ task, command, approvalQueue: context.approvalQueue });
    default:
      return {
        agent: agent.id,
        status: "completed",
        response: `No specialist executor is registered for ${agent.type}.`
      };
  }
}

function createAgentOrchestrator({ repository, approvalQueue, chatAgent, workspaceRoot }) {
  async function execute({ taskId, agent, command, approvalRequired = false, approvalId = null }) {
    const task = repository.findTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    updateStatus(repository, task.id, TASK_STATUSES.ASSIGNED, {
      assigned_agent_id: agent.id,
      assigned_agent_type: agent.type,
      supervisor: "ceo-agent"
    });
    if (approvalRequired) {
      updateStatus(repository, task.id, TASK_STATUSES.WAITING_APPROVAL, {
        approval_id: approvalId
      });
      return {
        status: TASK_STATUSES.WAITING_APPROVAL,
        response: `Task ${task.id} is waiting for approval before ${agent.name} executes it.`,
        approval_required: true,
        approval_id: approvalId,
        result: null
      };
    }
    updateStatus(repository, task.id, TASK_STATUSES.RUNNING, {
      command,
      pipeline: task.metadata?.execution_plan || []
    });

    try {
      const result = await executeTaskByAgent({
        agent,
        task,
        command,
        context: {
          repository,
          approvalQueue,
          chatAgent,
          workspaceRoot
        }
      });
      repository.appendTaskHistory(task.id, "agent.result", {
        agent_id: agent.id,
        agent_type: agent.type,
        result
      });

      if (requiresApproval(result)) {
        updateStatus(repository, task.id, TASK_STATUSES.WAITING_APPROVAL, {
          approval_id: latestApprovalId(result),
          latest_output: preview(result),
          next_action: "Approval required before the assigned agent can continue."
        });
        return {
          status: TASK_STATUSES.WAITING_APPROVAL,
          response: `Task ${task.id} is waiting for approval before continuing.`,
          approval_required: true,
          approval_id: latestApprovalId(result),
          result
        };
      }

      updateStatus(repository, task.id, TASK_STATUSES.COMPLETED, {
        latest_output: preview(result)
      });
      return {
        status: TASK_STATUSES.COMPLETED,
        response: result.response || result.message || preview(result),
        approval_required: false,
        result
      };
    } catch (error) {
      const failure = {
        message: error.message,
        agent_id: agent.id,
        agent_type: agent.type
      };
      repository.appendTaskHistory(task.id, "agent.failed", failure);
      updateStatus(repository, task.id, TASK_STATUSES.FAILED, {
        error: error.message
      });
      return {
        status: TASK_STATUSES.FAILED,
        response: `Task ${task.id} failed in ${agent.name}: ${error.message}`,
        approval_required: false,
        error: error.message
      };
    }
  }

  return { execute };
}

module.exports = {
  TASK_STATUSES,
  createAgentOrchestrator
};
