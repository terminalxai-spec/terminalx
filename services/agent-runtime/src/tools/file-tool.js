const fs = require("node:fs");
const path = require("node:path");

const { evaluateFilePermission } = require("../permissions/policy");

function workspaceRoot() {
  return path.resolve(process.env.TERMINALX_WORKSPACE_ROOT || process.cwd());
}

function resolveWorkspacePath(relativePath) {
  const root = workspaceRoot();
  const resolved = path.resolve(root, String(relativePath || ""));

  // Keep every file operation inside the configured workspace root.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("Path escapes the TerminalX workspace root.");
  }

  return { root, resolved };
}

function readProjectFile(relativePath) {
  const { root, resolved } = resolveWorkspacePath(relativePath);
  const content = fs.readFileSync(resolved, "utf8");

  return {
    path: path.relative(root, resolved),
    content
  };
}

function suggestCodeChange({ path: targetPath, currentContent = "", instructions = "" }) {
  return {
    path: targetPath,
    summary: "Suggested change prepared. No files were modified.",
    suggestion: [
      `Review file: ${targetPath}`,
      `Goal: ${instructions || "No instruction provided."}`,
      "Next: submit a modify-file request with approval if this change should be applied."
    ],
    currentContentPreview: currentContent.slice(0, 800)
  };
}

function createProjectFile({ path: targetPath, content = "" }) {
  const { root, resolved } = resolveWorkspacePath(targetPath);
  const permission = evaluateFilePermission("create", targetPath);

  if (fs.existsSync(resolved)) {
    throw new Error("File already exists. Use modify-file with approval.");
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");

  return {
    permission,
    path: path.relative(root, resolved),
    status: "created"
  };
}

function deleteProjectFile({ path: targetPath, approvalId, approvalQueue }) {
  const { root, resolved } = resolveWorkspacePath(targetPath);
  const permission = evaluateFilePermission("delete", targetPath);

  if (!approvalId || !approvalQueue.isApproved(approvalId)) {
    const approval = approvalQueue.add({
      title: `Approve file deletion: ${targetPath}`,
      requestedBy: "coding-agent",
      approvalType: permission.approvalType,
      riskLevel: permission.riskLevel,
      description: permission.reason,
      proposedAction: {
        tool: "file.delete",
        path: targetPath
      }
    });

    return {
      status: "approval_required",
      approval_required: true,
      approval_id: approval.id,
      permission
    };
  }

  if (!fs.existsSync(resolved)) {
    throw new Error("File does not exist.");
  }

  if (fs.statSync(resolved).isDirectory()) {
    throw new Error("Directory deletion is not supported by the MVP file tool.");
  }

  fs.unlinkSync(resolved);
  approvalQueue.logAction("file.deleted", {
    approvalId,
    path: path.relative(root, resolved),
    agent: "coding-agent"
  });

  return {
    status: "deleted",
    approval_required: false,
    path: path.relative(root, resolved)
  };
}

function modifyProjectFile({ path: targetPath, content = "", approvalId, approvalQueue }) {
  const { root, resolved } = resolveWorkspacePath(targetPath);
  const permission = evaluateFilePermission("modify", targetPath);

  if (!approvalId || !approvalQueue.isApproved(approvalId)) {
    const approval = approvalQueue.add({
      title: `Approve file modification: ${targetPath}`,
      requestedBy: "coding-agent",
      approvalType: permission.approvalType,
      riskLevel: permission.riskLevel,
      description: permission.reason,
      proposedAction: {
        tool: "file.modify",
        path: targetPath
      }
    });

    return {
      status: "approval_required",
      approval_required: true,
      approval_id: approval.id,
      permission
    };
  }

  fs.writeFileSync(resolved, content, "utf8");
  approvalQueue.logAction("file.modified", {
    approvalId,
    path: path.relative(root, resolved),
    agent: "coding-agent"
  });

  return {
    status: "modified",
    approval_required: false,
    path: path.relative(root, resolved)
  };
}

module.exports = {
  createProjectFile,
  deleteProjectFile,
  modifyProjectFile,
  readProjectFile,
  resolveWorkspacePath,
  suggestCodeChange
};
