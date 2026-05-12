const path = require("node:path");

const { runCommand } = require("../tools/command-tool");
const { detectTestFrameworks } = require("../tools/test-detector");

function resolveTestRoot(payload = {}) {
  return path.resolve(payload.workspace_root || process.env.TERMINALX_WORKSPACE_ROOT || process.cwd());
}

function summarizeFailure(commandResult) {
  if (commandResult.status === "completed") {
    return [];
  }

  const output = `${commandResult.stderr || ""}\n${commandResult.stdout || ""}`.trim();
  return [
    {
      title: "Test command failed",
      commandStatus: commandResult.status,
      exitCode: commandResult.exitCode,
      outputPreview: output.slice(0, 1200) || "No output captured."
    }
  ];
}

function suggestFixes(framework, failures) {
  if (!failures.length) {
    return ["No failures detected. Keep this test command in the verification checklist."];
  }

  const generic = [
    "Open the failing output and identify the first concrete assertion or compile error.",
    "Route the failure to Coding Agent with the command, framework, and output preview.",
    "Re-run the same test command after the Coding Agent patch."
  ];

  if (framework === "node") {
    return ["Check package scripts and missing dependencies before editing source.", ...generic];
  }

  if (framework === "rust") {
    return ["Run formatter and inspect the first compiler/test failure before broad refactors.", ...generic];
  }

  if (framework === "python") {
    return ["Check import errors and fixture setup before changing test assertions.", ...generic];
  }

  return generic;
}

function createCodingBugReport({ createTask, sourceTaskId, detected, commandResult, failures }) {
  if (!failures.length || typeof createTask !== "function") {
    return null;
  }

  return createTask({
    title: `Coding Agent bug report: ${detected.command}`,
    description: failures[0].outputPreview,
    assignedAgentId: "coding-agent",
    intent: "coding",
    sourceTaskId,
    testFramework: detected.framework,
    testCommand: detected.command,
    riskLevel: "low"
  });
}

async function runTests(payload, context) {
  const root = resolveTestRoot(payload);
  const detectedFrameworks = detectTestFrameworks(root);
  const selected = detectedFrameworks[0] || null;
  const taskId = payload.task_id || null;

  if (!selected) {
    const result = {
      agent: "testing-agent",
      status: "no_tests_found",
      task_id: taskId,
      workspace_root: root,
      detected_frameworks: [],
      response: "Testing Agent could not detect a supported test framework.",
      failures: [],
      suggestions: ["Add a package.json test script, Cargo.toml, pytest config, or go.mod."]
    };
    context.appendTaskHistory?.(taskId, "test.no_tests_found", result);
    return result;
  }

  const commandResult = await runCommand({
    command: selected.command,
    cwd: root,
    approvalQueue: context.approvalQueue
  });
  const failures = summarizeFailure(commandResult);
  const suggestions = suggestFixes(selected.framework, failures);
  const bugReportTask = createCodingBugReport({
    createTask: context.createTask,
    sourceTaskId: taskId,
    detected: selected,
    commandResult,
    failures
  });

  const result = {
    agent: "testing-agent",
    status: failures.length ? "failed" : "passed",
    task_id: taskId,
    workspace_root: root,
    selected_framework: selected,
    detected_frameworks: detectedFrameworks,
    command_result: commandResult,
    failures,
    suggestions,
    coding_bug_report: bugReportTask
      ? {
          task_id: bugReportTask.id,
          assigned_agent: "coding-agent",
          status: bugReportTask.status
        }
      : null
  };

  context.appendTaskHistory?.(taskId, "test.run", result);
  if (bugReportTask) {
    context.appendTaskHistory?.(bugReportTask.id, "test.bug_report_created", {
      source_task_id: taskId,
      selected_framework: selected,
      failures
    });
  }

  return result;
}

module.exports = { runTests };

