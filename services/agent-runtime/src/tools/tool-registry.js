const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  appendWorkspaceLog,
  createTaskWorkspace,
  listWorkspaceFiles,
  listWorkspaceLogs,
  resolveWorkspacePath
} = require("../workspace/execution-workspace");

const secretPattern = /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]+/gi;
const destructivePattern = /\b(rm\s+-rf|del\s+|remove-item|rmdir|format|shutdown|git\s+reset\s+--hard)\b/i;

function redactSecrets(value = "") {
  return String(value).replace(secretPattern, "$1=[redacted]");
}

function audit(context, toolName, payload = {}) {
  const safePayload = JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string") return redactSecrets(value);
    return value;
  }));
  context.logAction?.(`tool.${toolName}`, safePayload, context.agentId || null);
  if (context.taskId) {
    context.appendTaskHistory?.(context.taskId, `tool.${toolName}`, safePayload);
    appendWorkspaceLog(context.taskId, toolName, JSON.stringify(safePayload, null, 2));
  }
}

function runNodeFile(filePath, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [filePath], {
      cwd,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: "failed", exitCode: null, stdout, stderr: error.message }));
    child.on("close", (exitCode) => resolve({
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      stdout: redactSecrets(stdout),
      stderr: redactSecrets(stderr)
    }));
  });
}

function createToolRegistry(context = {}) {
  const tools = {
    "file-create": {
      name: "file-create",
      description: "Create a file inside the task execution workspace.",
      inputSchema: { taskId: "string", path: "string", content: "string", approvalId: "string" },
      permissionRequired: "files:upload",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("File creation requires human/admin approval.");
        }
        const { workspace, resolved } = resolveWorkspacePath(input.taskId, "files", input.path);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, input.content || "", "utf8");
        const result = {
          status: "created",
          path: input.path,
          workspace: workspace.relativeRoot,
          size: Buffer.byteLength(input.content || "")
        };
        audit(context, "file-create", result);
        return result;
      }
    },
    "file-read": {
      name: "file-read",
      description: "Read a file from the task execution workspace.",
      inputSchema: { taskId: "string", path: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const { resolved } = resolveWorkspacePath(input.taskId, "files", input.path);
        const result = {
          status: "read",
          path: input.path,
          content: fs.readFileSync(resolved, "utf8")
        };
        audit(context, "file-read", { status: result.status, path: result.path });
        return result;
      }
    },
    "file-edit": {
      name: "file-edit",
      description: "Edit a file inside the task execution workspace.",
      inputSchema: { taskId: "string", path: "string", content: "string", approvalId: "string" },
      permissionRequired: "files:upload",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        return tools["file-create"].execute(input);
      }
    },
    "code-run": {
      name: "code-run",
      description: "Run a safe Node.js file inside the task workspace.",
      inputSchema: { taskId: "string", command: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Shell/code execution requires human/admin approval.");
        }
        if (destructivePattern.test(input.command || "")) {
          throw new Error("Destructive command blocked.");
        }
        const parts = String(input.command || "").trim().split(/\s+/);
        if (parts[0] !== "node" || !parts[1]) {
          throw new Error("Only node <file> is supported in the safe workspace runner.");
        }
        const { workspace, resolved } = resolveWorkspacePath(input.taskId, "files", parts[1]);
        const result = await runNodeFile(resolved, workspace.filesDir);
        audit(context, "code-run", { command: input.command, ...result });
        return result;
      }
    },
    "test-run": {
      name: "test-run",
      description: "Run generated tests inside the task workspace.",
      inputSchema: { taskId: "string", testFile: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        const testFile = input.testFile || "terminalx-generated/calculator/calculator.test.js";
        return tools["code-run"].execute({
          taskId: input.taskId,
          command: `node ${testFile}`,
          approvalId: input.approvalId
        });
      }
    },
    "package-install": {
      name: "package-install",
      description: "Install packages inside a task workspace. Disabled until explicitly approved and implemented.",
      inputSchema: { taskId: "string", packageName: "string", approvalId: "string" },
      permissionRequired: "settings:manage",
      riskLevel: "high",
      approvalRequired: true,
      async execute() {
        throw new Error("Package install is approval-gated and not enabled in this MVP workspace runner.");
      }
    },
    "output-save": {
      name: "output-save",
      description: "Save output metadata inside the task workspace.",
      inputSchema: { taskId: "string", filename: "string", content: "string" },
      permissionRequired: "files:upload",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const { workspace, resolved } = resolveWorkspacePath(input.taskId, "outputs", input.filename || "output.txt");
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, input.content || "", "utf8");
        const result = { status: "saved", path: path.relative(workspace.outputsDir, resolved).replaceAll("\\", "/") };
        audit(context, "output-save", result);
        return result;
      }
    }
  };

  return {
    list() {
      return Object.values(tools).map(({ execute, ...tool }) => tool);
    },
    get(name) {
      return tools[name] || null;
    },
    async execute(name, input) {
      const tool = tools[name];
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.execute(input);
    },
    workspace(taskOrId) {
      return createTaskWorkspace(taskOrId);
    },
    listWorkspaceFiles,
    listWorkspaceLogs
  };
}

module.exports = {
  createToolRegistry,
  redactSecrets
};
