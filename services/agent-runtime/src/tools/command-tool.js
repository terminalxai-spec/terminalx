const { spawn } = require("node:child_process");
const path = require("node:path");

const { evaluateCommandPermission } = require("../permissions/policy");

const safeExecutables = new Set(["node", "npm", "git", "cargo", "python", "py", "go"]);
const safeGitSubcommands = new Set(["status", "diff", "log", "show"]);
const safeNpmSubcommands = new Set(["test", "run"]);

function splitCommand(command) {
  return String(command || "")
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((part) => part.replace(/^"|"$/g, "")) || [];
}

function isAllowlistedCommand(parts) {
  const [exe, subcommand] = parts;
  if (!safeExecutables.has(exe)) {
    return false;
  }

  if (exe === "git") {
    return safeGitSubcommands.has(subcommand);
  }

  if (exe === "npm") {
    if (!safeNpmSubcommands.has(subcommand)) {
      return false;
    }
    return subcommand === "test" || parts[2]?.startsWith("test");
  }

  if (exe === "cargo") {
    return subcommand === "test";
  }

  if (exe === "python" || exe === "py") {
    return parts[1] === "-m" && ["pytest", "unittest"].includes(parts[2]);
  }

  if (exe === "go") {
    return subcommand === "test";
  }

  if (exe === "node") {
    const scriptPath = String(parts[1] || "").replaceAll("\\", "/");
    return ["--check", "--test"].includes(parts[1]) || /^scripts\/[\w.-]+\.js$/.test(scriptPath);
  }

  return false;
}

function resolveInvocation(parts) {
  const [executable, ...args] = parts;

  if (executable === "node") {
    return {
      executable: process.execPath,
      args
    };
  }

  if (process.platform === "win32" && executable === "npm") {
    return {
      executable: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args]
    };
  }

  return {
    executable,
    args
  };
}

function canRunNodeScriptInProcess(parts) {
  const scriptPath = String(parts[1] || "").replaceAll("\\", "/");
  return parts[0] === "node" && /^scripts\/[\w.-]+\.js$/.test(scriptPath);
}

function runNodeScriptInProcess(parts, cwd) {
  const scriptPath = path.resolve(cwd, parts[1]);
  const previousCwd = process.cwd();
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  let stderr = "";

  console.log = (...args) => {
    stdout += `${args.join(" ")}\n`;
  };
  console.error = (...args) => {
    stderr += `${args.join(" ")}\n`;
  };

  try {
    process.chdir(cwd);
    delete require.cache[require.resolve(scriptPath)];
    require(scriptPath);
    return {
      status: "completed",
      exitCode: 0,
      stdout,
      stderr
    };
  } catch (error) {
    return {
      status: "failed",
      exitCode: 1,
      stdout,
      stderr: stderr || error.stack || error.message
    };
  } finally {
    process.chdir(previousCwd);
    console.log = originalLog;
    console.error = originalError;
  }
}

function runProcess(parts, cwd) {
  return new Promise((resolve) => {
    if (canRunNodeScriptInProcess(parts)) {
      resolve(runNodeScriptInProcess(parts, cwd));
      return;
    }

    const invocation = resolveInvocation(parts);
    let child;

    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd,
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      resolve({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: error.message
      });
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        status: "failed",
        exitCode: null,
        stdout,
        stderr: error.message
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        status: exitCode === 0 ? "completed" : "failed",
        exitCode,
        stdout,
        stderr
      });
    });
  });
}

async function runCommand({ command, cwd, approvalId, approvalQueue }) {
  const permission = evaluateCommandPermission(command);
  const parts = splitCommand(command);
  const hasApproval = Boolean(approvalId && approvalQueue.isApproved(approvalId));

  if (!parts.length) {
    throw new Error("command is required");
  }

  if (permission.decision === "require_approval" && !hasApproval) {
    const approval = approvalQueue.add({
      title: `Approve command: ${command}`,
      requestedBy: "coding-agent",
      approvalType: permission.approvalType,
      riskLevel: permission.riskLevel,
      description: permission.reason,
      proposedAction: {
        tool: "command.run",
        command
      }
    });

    return {
      status: "approval_required",
      approval_required: true,
      approval_id: approval.id,
      permission
    };
  }

  if (!isAllowlistedCommand(parts) && !hasApproval) {
    return {
      status: "blocked",
      approval_required: false,
      permission: {
        decision: "deny",
        riskLevel: "medium",
        reason: "Command is not on the safe allowlist."
      }
    };
  }

  const result = await runProcess(parts, cwd);
  approvalQueue.logAction("command.executed", {
    approvalId: approvalId || null,
    command,
    status: result.status,
    exitCode: result.exitCode,
    riskLevel: permission.riskLevel,
    approvalType: permission.approvalType
  });

  return {
    ...result,
    approval_required: false,
    permission
  };
}

module.exports = { runCommand };
