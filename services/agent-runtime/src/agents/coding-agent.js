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
const { createTaskWorkspace } = require("../workspace/execution-workspace");

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
  const workspace = createTaskWorkspace(task);
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
      workspace: workspace.relativeRoot,
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
      `Workspace prepared: ${workspace.relativeRoot}`,
      "Coding Agent received assigned task",
      "Requirements parsed",
      "Implementation files planned",
      approval ? "Approval requested for repo modification" : "No approval queue available"
    ],
    proposed_files: proposedFiles,
    workspace: workspace.relativeRoot
  };
}

function fileContentForTask(file, task, approval) {
  const command = approval?.proposedAction?.command || task.description || task.title;
  if (/calculator\.js$/i.test(file.path)) {
    return `const operations = {
  add: (left, right) => left + right,
  subtract: (left, right) => left - right,
  multiply: (left, right) => left * right,
  divide: (left, right) => {
    if (right === 0) {
      throw new Error("Cannot divide by zero.");
    }
    return left / right;
  }
};

function calculate(operation, left, right) {
  const handler = operations[operation];
  if (!handler) {
    throw new Error("Unsupported operation. Use add, subtract, multiply, or divide.");
  }
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    throw new Error("Both values must be valid numbers.");
  }
  return handler(left, right);
}

if (require.main === module) {
  const [, , operation, leftValue, rightValue] = process.argv;
  try {
    const result = calculate(operation, Number(leftValue), Number(rightValue));
    console.log(result);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { calculate };
`;
  }

  if (/calculator\.test\.js$/i.test(file.path)) {
    return `const assert = require("node:assert/strict");
const { calculate } = require("./calculator");

assert.equal(calculate("add", 2, 3), 5);
assert.equal(calculate("subtract", 7, 4), 3);
assert.equal(calculate("multiply", 6, 5), 30);
assert.equal(calculate("divide", 8, 2), 4);
assert.throws(() => calculate("divide", 8, 0), /divide by zero/i);
assert.throws(() => calculate("power", 2, 3), /unsupported operation/i);

console.log("Calculator tests passed.");
`;
  }

  if (/readme\.md$/i.test(file.path)) {
    return `# ${task.title}

Generated by TerminalX Coding Agent after human approval.

## Original request

${command}

## Run

\`\`\`bash
node calculator.js add 2 3
node calculator.js subtract 7 4
node calculator.js multiply 6 5
node calculator.js divide 8 2
\`\`\`

## Test

\`\`\`bash
node calculator.test.js
\`\`\`
`;
  }

  return `# ${task.title}

Generated by TerminalX Coding Agent.

Purpose: ${file.purpose || "Task artifact"}
`;
}

async function completeApprovedTask({ task, approval, storeFile, toolRegistry }) {
  const proposedFiles = approval?.proposedAction?.proposedFiles || [];
  const workspace = createTaskWorkspace(task);
  const createdFiles = [];
  const logs = ["Approval received", "Creating files"];

  for (const file of proposedFiles) {
    const content = fileContentForTask(file, task, approval);
    const workspaceWrite = await toolRegistry.execute("file-create", {
      taskId: task.id,
      path: file.path,
      content,
      approvalId: approval.id
    });
    const stored = await storeFile({
      filename: file.path.split(/[\\/]/).pop(),
      path: file.path,
      task_id: task.id,
      mime_type: /\.md$/i.test(file.path) ? "text/markdown" : "text/javascript",
      content,
      metadata: {
        generated_by: "coding-agent",
        purpose: file.purpose || "",
        approval_id: approval.id
      }
    });
    createdFiles.push({
      path: file.path,
      file_id: stored.id,
      workspace_path: workspaceWrite.path,
      purpose: file.purpose || ""
    });
  }

  logs.push("Files created");
  logs.push("Running tests");
  const testFile = proposedFiles.find((file) => /\.test\.js$/i.test(file.path))?.path;
  const testResult = testFile
    ? await toolRegistry.execute("test-run", {
        taskId: task.id,
        testFile,
        approvalId: approval.id
      })
    : { status: "no_tests_found", stdout: "", stderr: "" };
  logs.push(testResult.status === "passed" ? "Tests passed" : "Tests failed");
  await toolRegistry.execute("output-save", {
    taskId: task.id,
    filename: "result.json",
    content: JSON.stringify({ files: createdFiles, testResult }, null, 2)
  });
  logs.push(testResult.status === "passed" ? "Task completed" : "Task failed");

  return {
    agent: "coding-agent",
    action: "complete_approved_task",
    status: testResult.status === "passed" || testResult.status === "no_tests_found" ? "completed" : "failed",
    response: `Coding Agent created ${createdFiles.length} approved file(s).`,
    logs,
    workspace: workspace.relativeRoot,
    generated_directory: proposedFiles[0]?.path?.split("/").slice(0, -1).join("/") || "terminalx-generated/",
    files: createdFiles,
    test_result: testResult
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
  completeApprovedTask,
  createFile,
  deleteFile,
  executeAssignedTask,
  executeCommand,
  githubStatus,
  modifyFile,
  readFile,
  suggestChange
};
