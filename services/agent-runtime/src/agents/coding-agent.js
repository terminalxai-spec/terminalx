const path = require("node:path");

const {
  createProjectFile,
  deleteProjectFile,
  modifyProjectFile,
  readProjectFile,
  suggestCodeChange
} = require("../tools/file-tool");
const { runCommand } = require("../tools/command-tool");
const { getGitHubPlaceholder } = require("../integrations/github-placeholder");

function codingWorkspaceRoot() {
  return path.resolve(process.env.TERMINALX_WORKSPACE_ROOT || process.cwd());
}

function readFile(payload) {
  return {
    agent: "coding-agent",
    action: "read_file",
    result: readProjectFile(payload.path)
  };
}

function suggestChange(payload) {
  return {
    agent: "coding-agent",
    action: "suggest_change",
    result: suggestCodeChange(payload)
  };
}

function proposedFilesForTask(task, command) {
  const requirements = task.metadata?.requirements || [];
  if (/\bcalculator\b/i.test(`${task.title} ${task.description} ${command}`)) {
    return [
      {
        path: "terminalx-generated/calculator/calculator.js",
        purpose: "CLI calculator implementation with add/subtract/multiply/divide operations and input validation."
      },
      {
        path: "terminalx-generated/calculator/calculator.test.js",
        purpose: "Focused tests for arithmetic operations and invalid input handling."
      },
      {
        path: "terminalx-generated/calculator/README.md",
        purpose: "Usage guide for running the CLI calculator and tests."
      }
    ];
  }

  return [
    {
      path: "terminalx-generated/implementation/README.md",
      purpose: `Implementation notes for: ${task.title}`
    },
    {
      path: "terminalx-generated/implementation/index.js",
      purpose: "Minimal implementation entry point."
    },
    {
      path: "terminalx-generated/implementation/index.test.js",
      purpose: "Focused validation tests."
    }
  ].filter(Boolean).map((file) => ({
    ...file,
    requirements
  }));
}

function executeAssignedTask({ task, command, approvalQueue }) {
  const proposedFiles = proposedFilesForTask(task, command);
  const approval = approvalQueue?.add?.({
    title: `Approve Coding Agent file generation for ${task.title}`,
    taskId: task.id,
    requestedBy: "coding-agent",
    assignedAgentId: "coding-agent",
    approvalType: "repo_modification",
    riskLevel: "medium",
    description: "Coding Agent prepared a file-generation workflow. Approval is required before writing files.",
    proposedAction: {
      command,
      proposedFiles,
      requirements: task.metadata?.requirements || []
    }
  });

  return {
    agent: "coding-agent",
    action: "execute_assigned_task",
    status: approval ? "approval_required" : "planned",
    approval_required: Boolean(approval),
    approval_id: approval?.id || null,
    response: approval
      ? "Coding Agent analyzed the task and prepared file changes. Approval is required before writing to the workspace."
      : "Coding Agent analyzed the task and prepared an implementation plan.",
    logs: [
      "Coding Agent received assigned task",
      "Requirements parsed",
      "Implementation files planned",
      approval ? "Approval requested for repo modification" : "No approval queue available"
    ],
    proposed_files: proposedFiles
  };
}

function createFile(payload) {
  return {
    agent: "coding-agent",
    action: "create_file",
    result: createProjectFile(payload)
  };
}

function modifyFile(payload, approvalQueue) {
  return {
    agent: "coding-agent",
    action: "modify_file",
    result: modifyProjectFile({ ...payload, approvalQueue })
  };
}

function deleteFile(payload, approvalQueue) {
  return {
    agent: "coding-agent",
    action: "delete_file",
    result: deleteProjectFile({ ...payload, approvalQueue })
  };
}

async function executeCommand(payload, approvalQueue) {
  return {
    agent: "coding-agent",
    action: "run_command",
    result: await runCommand({
      command: payload.command,
      cwd: codingWorkspaceRoot(),
      approvalId: payload.approval_id,
      approvalQueue
    })
  };
}

function githubStatus() {
  return {
    agent: "coding-agent",
    action: "github_status",
    result: getGitHubPlaceholder()
  };
}

module.exports = {
  createFile,
  deleteFile,
  executeAssignedTask,
  executeCommand,
  githubStatus,
  modifyFile,
  readFile,
  suggestChange
};
