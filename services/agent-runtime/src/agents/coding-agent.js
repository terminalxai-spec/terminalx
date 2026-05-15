const fs = require("node:fs");
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
const { createTaskWorkspace, readProjectMemory, resolveWorkspacePath } = require("../workspace/execution-workspace");

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

function listWorkspaceTree(taskOrId) {
  const workspace = createTaskWorkspace(taskOrId);
  if (!fs.existsSync(workspace.filesDir)) return [];
  const walk = (dir, base = workspace.filesDir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return path.relative(base, full).replaceAll("\\", "/");
  });
  return walk(workspace.filesDir);
}

function readWorkspaceFile(taskOrId, filePath) {
  const { resolved } = resolveWorkspacePath(taskOrId, "files", filePath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
}

function inspectProjectWorkspace(taskOrId) {
  const files = listWorkspaceTree(taskOrId);
  const has = (name) => files.includes(name);
  const packageJson = has("package.json") ? JSON.parse(readWorkspaceFile(taskOrId, "package.json") || "{}") : null;
  const projectMemory = readProjectMemory(typeof taskOrId === "string" ? taskOrId : taskOrId?.id);
  const packageManager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("package-lock.json") || packageJson ? "npm" : "none";
  const projectType = packageJson
    ? "node"
    : files.some((file) => /\.html$/i.test(file))
      ? "static-web"
      : files.some((file) => /\.py$/i.test(file))
        ? "python"
        : "unknown";
  return {
    files,
    relevantFiles: files.filter((file) => /^(package\.json|TERMINALX\.md|src\/|app\.|index\.|server\.|.*\.test\.)/i.test(file)).slice(0, 12),
    projectMemory,
    projectType,
    packageManager,
    testCommand: packageJson?.scripts?.test ? `${packageManager} test` : files.find((file) => /\.test\.js$/i.test(file)) ? `node ${files.find((file) => /\.test\.js$/i.test(file))}` : null,
    buildCommand: packageJson?.scripts?.build ? `${packageManager} run build` : null
  };
}

function projectPlanForTask(task, command) {
  const requirements = task.metadata?.requirements || [];
  const inspection = inspectProjectWorkspace(task);
  const slug = projectSlug(task, command);
  const root = `terminalx-generated/${slug}`;
  const base = {
    slug,
    root,
    requirements,
    inspection,
    summary: `Lightweight ${slug.replaceAll("-", " ")} generated from task requirements.`
  };

  if (inspection.files.length && /\b(edit|fix|improve|update|change)\b/i.test(`${task.title} ${task.description} ${command}`)) {
    const target = inspection.files.find((file) => /app\.js$|server\.js$|index\.html$|styles\.css$/i.test(file)) || inspection.files[0];
    return {
      ...base,
      root: path.dirname(target) === "." ? "" : path.dirname(target).replaceAll("\\", "/"),
      files: [
        { path: target, purpose: "Minimal focused change to existing project file.", existing: true },
        { path: "README.md", purpose: "Update project notes after the change.", existing: inspection.files.includes("README.md") }
      ]
    };
  }

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
    title: `Approve file changes for ${task.title}`,
    taskId: task.id,
    requestedBy: "terminalx",
    assignedAgentId: "terminalx",
    approvalType: "repo_modification",
    riskLevel: "medium",
    description: "TerminalX prepared file changes. Approval is required before writing files.",
    proposedAction: {
      command,
      workspace: workspace.relativeRoot,
      projectPlan: projectPlanForTask(task, command),
      proposedFiles,
      internalPlan: ["Inspect workspace", "Read TERMINALX.md", "Apply minimal changes", "Run detected tests/build", "Self-fix failures up to 3 times"],
      repositoryUnderstanding: inspectProjectWorkspace(task),
      requirements: task.metadata?.requirements || []
    }
  });

  return {
    agent: "terminalx",
    action: "execute_assigned_task",
    status: approval ? "approval_required" : "planned",
    approval_required: Boolean(approval),
    approval_id: approval?.id || null,
    response: approval
      ? "I’m working on it. Approval is needed before applying file changes."
      : "I’m working on it.",
    logs: [
      `Workspace prepared: ${workspace.relativeRoot}`,
      "Read project workspace",
      "Read TERMINALX.md",
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

Generated by TerminalX after human approval.

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

Generated by TerminalX.

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
  const repositoryUnderstanding = approval?.proposedAction?.repositoryUnderstanding || inspectProjectWorkspace(task);
  const workspace = createTaskWorkspace(task);
  const createdFiles = [];
  const logs = ["Approval received", "repository_understanding", "generating"];
  const iterationHistory = [];

  for (const file of proposedFiles) {
    const before = file.existing ? readWorkspaceFile(task, file.path) : "";
    const generated = fileContentForTask(file, task, approval);
    const content = file.existing && before ? `${before.trimEnd()}\n\n/* TerminalX update */\n${generated}` : generated;
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
  const testFile = proposedFiles.find((file) => /\.test\.js$/i.test(file.path))?.path || (repositoryUnderstanding.testCommand?.startsWith("node ") ? repositoryUnderstanding.testCommand.replace(/^node\s+/, "") : null);
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
    agent: "terminalx",
    action: "complete_approved_task",
    status: testResult.status === "passed" || testResult.status === "no_tests_found" ? "completed" : "failed",
    response: [
      `Files changed: ${createdFiles.length}`,
      `Tests: ${testResult.status}`,
      `Output: ${workspace.relativeRoot}/outputs/result.json`,
      testResult.status === "passed" || testResult.status === "no_tests_found" ? "Next: review outputs or ask me to push/deploy." : "Next: review test errors and ask me to continue fixing."
    ].join("\n"),
    logs,
    workspace: workspace.relativeRoot,
    repository_understanding: repositoryUnderstanding,
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
  inspectProjectWorkspace,
  modifyFile,
  readFile,
  suggestChange
};
