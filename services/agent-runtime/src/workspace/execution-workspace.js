const fs = require("node:fs");
const path = require("node:path");

function workspaceBaseRoot() {
  return path.resolve(process.env.TERMINALX_EXECUTION_ROOT || path.join(process.cwd(), "storage", "workspaces"));
}

function slugForTask(taskOrId) {
  const raw = typeof taskOrId === "string" ? taskOrId : taskOrId?.id || taskOrId?.title || "task";
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "task";
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function createTaskWorkspace(taskOrId) {
  const slug = slugForTask(taskOrId);
  const root = path.join(workspaceBaseRoot(), "projects", slug);
  const filesDir = ensureDir(path.join(root, "files"));
  const logsDir = ensureDir(path.join(root, "logs"));
  const outputsDir = ensureDir(path.join(root, "outputs"));
  return {
    id: slug,
    root,
    filesDir,
    logsDir,
    outputsDir,
    relativeRoot: path.relative(process.cwd(), root).replaceAll("\\", "/")
  };
}

function createProjectChatWorkspace(conversationId, goal = "") {
  const workspace = createTaskWorkspace(conversationId || "project-chat");
  const memoryPath = path.join(workspace.root, "TERMINALX.md");
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, [
      "# TerminalX Project Memory",
      "",
      `Project goal: ${goal || "Not set yet."}`,
      "",
      "## User preferences",
      "- Chat-first normal mode",
      "- Hide internal routing unless advanced mode is enabled",
      "",
      "## Architecture notes",
      "- Workspace files live under files/",
      "- Outputs live under outputs/",
      "",
      "## Known issues",
      "- None recorded yet.",
      "",
      "## Successful fixes",
      "- None recorded yet.",
      "",
      "## Deployment notes",
      "- No deployment linked yet."
    ].join("\n"), "utf8");
  }
  return {
    ...workspace,
    memoryPath,
    linkedFiles: listWorkspaceFiles(conversationId || "project-chat"),
    linkedOutputs: listFilesRecursive(workspace.outputsDir),
    git: { repo: null, branch: null },
    deploymentUrl: null
  };
}

function readProjectMemory(conversationId) {
  const workspace = createProjectChatWorkspace(conversationId);
  return fs.existsSync(workspace.memoryPath) ? fs.readFileSync(workspace.memoryPath, "utf8") : "";
}

function appendProjectMemory(conversationId, section, content) {
  const workspace = createProjectChatWorkspace(conversationId);
  fs.appendFileSync(workspace.memoryPath, `\n\n## ${section}\n${content}\n`, "utf8");
  return readProjectMemory(conversationId);
}

function assertInside(parent, target) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  if (targetPath !== parentPath && !targetPath.startsWith(parentPath + path.sep)) {
    throw new Error("Workspace path escape blocked.");
  }
  return targetPath;
}

function resolveWorkspacePath(taskOrId, area = "files", relativePath = "") {
  const workspace = createTaskWorkspace(taskOrId);
  const areaRoot = area === "logs" ? workspace.logsDir : area === "outputs" ? workspace.outputsDir : workspace.filesDir;
  return {
    workspace,
    areaRoot,
    resolved: assertInside(areaRoot, path.resolve(areaRoot, String(relativePath || "")))
  };
}

function listFilesRecursive(root, base = root) {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFilesRecursive(fullPath, base);
    }
    const stat = fs.statSync(fullPath);
    return [{
      path: path.relative(base, fullPath).replaceAll("\\", "/"),
      size: stat.size,
      updatedAt: stat.mtime.toISOString()
    }];
  });
}

function listWorkspaceFiles(taskOrId) {
  const workspace = createTaskWorkspace(taskOrId);
  return listFilesRecursive(workspace.filesDir);
}

function readWorkspaceFile(taskOrId, relativePath) {
  const { resolved } = resolveWorkspacePath(taskOrId, "files", relativePath);
  return fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
}

function changeHistoryPath(taskOrId) {
  const { workspace } = resolveWorkspacePath(taskOrId, "outputs", "");
  return path.join(workspace.outputsDir, "change-history.json");
}

function listChangeHistory(taskOrId) {
  const filePath = changeHistoryPath(taskOrId);
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8") || "[]");
}

function appendChangeHistory(taskOrId, entry) {
  const history = listChangeHistory(taskOrId);
  history.unshift({ ...entry, createdAt: entry.createdAt || new Date().toISOString() });
  const filePath = changeHistoryPath(taskOrId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(history, null, 2), "utf8");
  return history[0];
}

function listWorkspaceLogs(taskOrId) {
  const workspace = createTaskWorkspace(taskOrId);
  return listFilesRecursive(workspace.logsDir).map((entry) => ({
    ...entry,
    content: fs.readFileSync(path.join(workspace.logsDir, entry.path), "utf8").slice(0, 4000)
  }));
}

function appendWorkspaceLog(taskOrId, name, content) {
  const { resolved } = resolveWorkspacePath(taskOrId, "logs", `${Date.now()}-${name}.log`);
  fs.writeFileSync(resolved, `${content}\n`, "utf8");
  return resolved;
}

module.exports = {
  appendWorkspaceLog,
  appendProjectMemory,
  appendChangeHistory,
  createProjectChatWorkspace,
  createTaskWorkspace,
  listChangeHistory,
  listWorkspaceFiles,
  listWorkspaceLogs,
  readProjectMemory,
  readWorkspaceFile,
  resolveWorkspacePath,
  slugForTask,
  workspaceBaseRoot
};
