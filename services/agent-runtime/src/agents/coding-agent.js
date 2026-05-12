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
  executeCommand,
  githubStatus,
  modifyFile,
  readFile,
  suggestChange
};
