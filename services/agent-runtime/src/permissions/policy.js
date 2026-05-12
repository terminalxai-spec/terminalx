const destructiveCommandPatterns = [
  { pattern: /\brm\s+-rf\b/i, approvalType: "destructive_shell_command", reason: "Recursive force deletion is destructive." },
  { pattern: /\brmdir\b/i, approvalType: "file_deletion", reason: "Directory deletion requires approval." },
  { pattern: /\bdel\s+/i, approvalType: "file_deletion", reason: "File deletion requires approval." },
  { pattern: /\bremove-item\b/i, approvalType: "file_deletion", reason: "PowerShell deletion requires approval." },
  { pattern: /\bgit\s+reset\s+--hard\b/i, approvalType: "destructive_shell_command", reason: "Hard reset can destroy local work." },
  { pattern: /\bgit\s+push\b.*\s--force\b/i, approvalType: "destructive_shell_command", reason: "Force push can rewrite shared history." },
  { pattern: /\bdrop\s+database\b/i, approvalType: "database_migration", reason: "Database destructive operation requires approval." },
  { pattern: /\bformat\b/i, approvalType: "destructive_shell_command", reason: "Format-like commands are destructive." },
  { pattern: /\bshutdown\b/i, approvalType: "destructive_shell_command", reason: "Shutdown commands require approval." }
];

const writeLikeCommandPatterns = [
  { pattern: /\bnpm\s+install\b/i, approvalType: "write_command", reason: "Installing dependencies changes project files." },
  { pattern: /\bgit\s+commit\b/i, approvalType: "write_command", reason: "Git commits change repository state." },
  { pattern: /\bgit\s+push\b/i, approvalType: "external_posting", reason: "Git push sends code to an external remote." },
  { pattern: /\bdeploy\b/i, approvalType: "production_deploy", reason: "Deploy commands require approval." },
  { pattern: /\bproduction\b|\bprod\b/i, approvalType: "production_deploy", reason: "Production-targeted commands require approval." },
  { pattern: /\bmigrate\b|\bmigration\b|\bdb:migrate\b|\balembic\s+upgrade\b/i, approvalType: "database_migration", reason: "Database migrations require approval." },
  { pattern: /\bpost\b|\btweet\b|\bpublish\b|\bsend\s+email\b/i, approvalType: "external_posting", reason: "External posting requires approval." },
  { pattern: /\bbuy\b|\bsell\b|\bplace\s+order\b|\bexecute\s+trade\b/i, approvalType: "trading_execution", reason: "Trading execution requires approval." },
  { pattern: />/, approvalType: "write_command", reason: "Shell redirection can write files." },
  { pattern: />>/, approvalType: "write_command", reason: "Shell redirection can append files." }
];

function evaluateCommandPermission(command) {
  const normalized = String(command || "").trim();

  const destructiveMatch = destructiveCommandPatterns.find((rule) => rule.pattern.test(normalized));
  if (destructiveMatch) {
    return {
      decision: "require_approval",
      riskLevel: "critical",
      approvalType: destructiveMatch.approvalType,
      reason: destructiveMatch.reason
    };
  }

  const writeLikeMatch = writeLikeCommandPatterns.find((rule) => rule.pattern.test(normalized));
  if (writeLikeMatch) {
    return {
      decision: "require_approval",
      riskLevel: "high",
      approvalType: writeLikeMatch.approvalType,
      reason: writeLikeMatch.reason
    };
  }

  return {
    decision: "allow",
    riskLevel: "low",
    approvalType: null,
    reason: "Command matched safe execution policy."
  };
}

function evaluateFilePermission(action, targetPath) {
  if (action === "delete") {
    return {
      decision: "require_approval",
      riskLevel: "critical",
      approvalType: "file_deletion",
      reason: `Deleting a file requires approval: ${targetPath}`
    };
  }

  if (action === "modify") {
    return {
      decision: "require_approval",
      riskLevel: "medium",
      approvalType: "modify_file",
      reason: `Modifying an existing file requires approval: ${targetPath}`
    };
  }

  if (action === "create") {
    return {
      decision: "allow",
      riskLevel: "low",
      approvalType: null,
      reason: `Creating a new file is allowed inside the workspace: ${targetPath}`
    };
  }

  return {
    decision: "allow",
    riskLevel: "low",
    approvalType: null,
    reason: "Read-only file operation."
  };
}

module.exports = {
  evaluateCommandPermission,
  evaluateFilePermission
};
