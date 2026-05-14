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

function projectSlug(task, command) {
  const text = `${task.title} ${task.description} ${command}`.toLowerCase();
  if (/\bcalculator\b/.test(text)) return "calculator";
  if (/\btodo\b|\bto-do\b/.test(text)) return "todo-app";
  if (/\blanding\b/.test(text)) return "landing-page";
  if (/\bblog\b/.test(text)) return "blog-starter";
  if (/\bapi\b|\bserver\b|\bbackend\b/.test(text)) return "api-server";
  if (/\bportfolio\b/.test(text)) return "portfolio-site";
  return "implementation";
}

function projectPlanForTask(task, command) {
  const requirements = task.metadata?.requirements || [];
  const slug = projectSlug(task, command);
  const root = `terminalx-generated/${slug}`;
  const base = {
    slug,
    root,
    requirements,
    summary: `Lightweight ${slug.replaceAll("-", " ")} generated from task requirements.`
  };

  if (slug === "calculator") {
    return {
      ...base,
      files: [
        { path: `${root}/calculator.js`, purpose: "CLI calculator implementation with add/subtract/multiply/divide operations and input validation." },
        { path: `${root}/calculator.test.js`, purpose: "Focused tests for arithmetic operations and invalid input handling.", test: true },
        { path: `${root}/README.md`, purpose: "Usage guide for running the CLI calculator and tests." }
      ]
    };
  }

  if (slug === "api-server") {
    return {
      ...base,
      files: [
        { path: `${root}/package.json`, purpose: "Node package metadata and test command." },
        { path: `${root}/server.js`, purpose: "Dependency-free HTTP API server." },
        { path: `${root}/server.test.js`, purpose: "Minimal API handler tests.", test: true },
        { path: `${root}/README.md`, purpose: "API server setup and usage notes." }
      ]
    };
  }

  return {
    ...base,
    files: [
      { path: `${root}/index.html`, purpose: "Main browser entry point." },
      { path: `${root}/styles.css`, purpose: "Responsive lightweight styling." },
      { path: `${root}/app.js`, purpose: "Small client-side app behavior." },
      { path: `${root}/app.test.js`, purpose: "Static project validation test.", test: true },
      { path: `${root}/README.md`, purpose: "Project overview and run instructions." }
    ]
  };
}

function proposedFilesForTask(task, command) {
  const plan = projectPlanForTask(task, command);
  return plan.files.map((file) => ({
    ...file,
    requirements: plan.requirements,
    project_slug: plan.slug,
    project_root: plan.root,
    project_summary: plan.summary
  }));
}

function mimeTypeForPath(filePath) {
  if (/\.md$/i.test(filePath)) return "text/markdown";
  if (/\.html$/i.test(filePath)) return "text/html";
  if (/\.css$/i.test(filePath)) return "text/css";
  if (/\.json$/i.test(filePath)) return "application/json";
  return "text/javascript";
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
      projectPlan: projectPlanForTask(task, command),
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

function shouldCreateInitialFailure(task, approval) {
  const text = `${task.title} ${task.description} ${approval?.proposedAction?.command || ""} ${(task.metadata?.requirements || []).join(" ")}`;
  return /\bself[- ]?fix\b|\bfailing generated\b|\binitial failure\b/i.test(text);
}

function fileContentForTask(file, task, approval, options = {}) {
  const command = approval?.proposedAction?.command || task.description || task.title;
  const plan = approval?.proposedAction?.projectPlan || projectPlanForTask(task, command);
  const title = task.title || "Generated Project";
  const requirementText = (plan.requirements || []).map((item) => `- ${item}`).join("\n") || "- Generated from user request";
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
    const runCommand = plan.slug === "api-server"
      ? "node server.js"
      : plan.slug === "calculator"
        ? "node calculator.js add 2 3"
        : "Open index.html in a browser.";
    const testCommand = plan.slug === "api-server"
      ? "node server.test.js"
      : plan.slug === "calculator"
        ? "node calculator.test.js"
        : "node app.test.js";
    return `# ${task.title}

Generated by TerminalX Coding Agent after human approval.

## Original request

${command}

## Requirements

${requirementText}

## Run

\`\`\`bash
${runCommand}
\`\`\`

## Test

\`\`\`bash
${testCommand}
\`\`\`
`;
  }

  if (/package\.json$/i.test(file.path)) {
    return `${JSON.stringify({
      name: plan.slug || "terminalx-generated-app",
      version: "0.1.0",
      private: true,
      type: "commonjs",
      scripts: {
        start: "node server.js",
        test: "node server.test.js"
      }
    }, null, 2)}
`;
  }

  if (/server\.js$/i.test(file.path)) {
    if (!options.fixed && shouldCreateInitialFailure(task, approval)) {
      return `const http = require("node:http");

function handler(req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: "Initial generated server" }));
}

if (require.main === module) {
  http.createServer(handler).listen(process.env.PORT || 3000);
}
`;
    }
    return `const http = require("node:http");

function handler(req, res) {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, app: ${JSON.stringify(title)} }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    name: ${JSON.stringify(title)},
    message: "TerminalX generated API server",
    requirements: ${JSON.stringify(plan.requirements || [])}
  }));
}

if (require.main === module) {
  http.createServer(handler).listen(process.env.PORT || 3000, () => {
    console.log("API server running");
  });
}

module.exports = { handler };
`;
  }

  if (/server\.test\.js$/i.test(file.path)) {
    return `const assert = require("node:assert/strict");
const { handler } = require("./server");

assert.equal(typeof handler, "function");
console.log("API server tests passed.");
`;
  }

  if (/index\.html$/i.test(file.path)) {
    const body = plan.slug === "todo-app"
      ? '<main class="shell"><h1>Todo App</h1><form id="todo-form"><input id="todo-input" placeholder="Add a task" required><button>Add</button></form><ul id="todo-list"></ul></main>'
      : plan.slug === "blog-starter"
        ? '<main class="shell"><h1>Blog Starter</h1><article><h2>First Post</h2><p>Edit this starter post and publish your ideas.</p></article></main>'
        : plan.slug === "portfolio-site"
          ? '<main class="shell"><h1>Portfolio</h1><p>Showcase your work, skills, and contact details.</p><section id="projects"></section></main>'
          : '<main class="shell"><h1>Landing Page</h1><p>A focused product page generated by TerminalX.</p><button id="cta">Get Started</button></main>';
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  ${body}
  <script src="./app.js"></script>
</body>
</html>
`;
  }

  if (/styles\.css$/i.test(file.path)) {
    return `body {
  margin: 0;
  font-family: Arial, sans-serif;
  background: #071019;
  color: #eef7ff;
}
.shell {
  width: min(920px, calc(100% - 32px));
  margin: 48px auto;
}
input, button {
  min-height: 42px;
  border-radius: 8px;
  border: 1px solid #21445c;
  padding: 0 12px;
}
button {
  background: #32d3f5;
  color: #031018;
  font-weight: 700;
}
li {
  margin: 8px 0;
}
`;
  }

  if (/app\.js$/i.test(file.path)) {
    if (plan.slug === "todo-app") {
      return `const form = document.querySelector("#todo-form");
const input = document.querySelector("#todo-input");
const list = document.querySelector("#todo-list");

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  const item = document.createElement("li");
  item.textContent = value;
  list.appendChild(item);
  input.value = "";
});
`;
    }
    return `document.querySelector("#cta")?.addEventListener("click", () => {
  document.body.dataset.started = "true";
});
`;
  }

  if (/app\.test\.js$/i.test(file.path)) {
    return `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

for (const file of ["index.html", "styles.css", "app.js", "README.md"]) {
  assert.equal(fs.existsSync(path.join(__dirname, file)), true, file + " should exist");
}
assert.match(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), /<main/i);
console.log("Static app tests passed.");
`;
  }

  return `# ${task.title}

Generated by TerminalX Coding Agent.

Purpose: ${file.purpose || "Task artifact"}

## Requirements

${requirementText}
`;
}

function fixContentForFailure(file, task, approval, testResult) {
  const combinedOutput = `${testResult?.stdout || ""}\n${testResult?.stderr || ""}`;
  if (/server\.js$/i.test(file.path) && /handler|function|undefined|not a function|module\.exports/i.test(combinedOutput)) {
    return fileContentForTask(file, task, approval, { fixed: true });
  }
  if (/app\.js$/i.test(file.path) && /document is not defined|syntax/i.test(combinedOutput)) {
    return fileContentForTask(file, task, approval, { fixed: true });
  }
  return null;
}

async function runGeneratedTests({ task, approval, toolRegistry, testFile }) {
  return testFile
    ? toolRegistry.execute("test-run", {
        taskId: task.id,
        testFile,
        approvalId: approval.id
      })
    : { status: "no_tests_found", stdout: "", stderr: "" };
}

async function completeApprovedTask({ task, approval, storeFile, toolRegistry }) {
  const proposedFiles = approval?.proposedAction?.proposedFiles || [];
  const workspace = createTaskWorkspace(task);
  const createdFiles = [];
  const logs = ["Approval received", "generating"];
  const iterationHistory = [];

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
      mime_type: mimeTypeForPath(file.path),
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
  logs.push("testing");
  const testFile = proposedFiles.find((file) => /\.test\.js$/i.test(file.path))?.path;
  let testResult = await runGeneratedTests({ task, approval, toolRegistry, testFile });
  iterationHistory.push({ iteration: 1, phase: "testing", testResult });

  const maxIterations = 3;
  for (let iteration = 2; testResult.status === "failed" && iteration <= maxIterations; iteration += 1) {
    logs.push("fixing");
    const fixes = proposedFiles
      .map((file) => ({ file, content: fixContentForFailure(file, task, approval, testResult) }))
      .filter((fix) => fix.content !== null);

    iterationHistory.push({
      iteration,
      phase: "fixing",
      error: `${testResult.stdout || ""}\n${testResult.stderr || ""}`.trim(),
      fixes: fixes.map((fix) => fix.file.path)
    });

    if (!fixes.length) {
      break;
    }

    for (const fix of fixes) {
      await toolRegistry.execute("file-edit", {
        taskId: task.id,
        path: fix.file.path,
        content: fix.content,
        approvalId: approval.id
      });
    }

    logs.push("retesting");
    testResult = await runGeneratedTests({ task, approval, toolRegistry, testFile });
    iterationHistory.push({ iteration, phase: "retesting", testResult });
  }

  logs.push(testResult.status === "passed" ? "completed" : "failed");
  await toolRegistry.execute("output-save", {
    taskId: task.id,
    filename: "result.json",
    content: JSON.stringify({
      projectPlan: approval?.proposedAction?.projectPlan || null,
      files: createdFiles,
      testResult,
      iterationHistory,
      fixAttempts: iterationHistory.filter((entry) => entry.phase === "fixing")
    }, null, 2)
  });
  logs.push("saving_outputs");

  return {
    agent: "coding-agent",
    action: "complete_approved_task",
    status: testResult.status === "passed" || testResult.status === "no_tests_found" ? "completed" : "failed",
    response: `Coding Agent created ${createdFiles.length} approved file(s).`,
    logs,
    workspace: workspace.relativeRoot,
    generated_directory: proposedFiles[0]?.path?.split("/").slice(0, -1).join("/") || "terminalx-generated/",
    files: createdFiles,
    test_result: testResult,
    iterations: iterationHistory,
    fix_attempts: iterationHistory.filter((entry) => entry.phase === "fixing")
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
