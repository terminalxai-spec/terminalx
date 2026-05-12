// Permission modes mirror the existing Claw idea of progressively riskier
// execution levels, then extend it with TerminalX product concepts.
const permissionModes = [
  {
    id: "read_only",
    label: "Read only",
    requiresApproval: false,
    description: "Can inspect tasks, files, and context without changing state."
  },
  {
    id: "workspace_write",
    label: "Workspace write",
    requiresApproval: true,
    description: "Can modify project files after policy or human approval."
  },
  {
    id: "code_execution",
    label: "Code execution",
    requiresApproval: true,
    description: "Can run commands, tests, and scripts in approved workspaces."
  },
  {
    id: "file_storage_write",
    label: "File storage write",
    requiresApproval: false,
    description: "Can create online file artifacts."
  },
  {
    id: "internet_access",
    label: "Internet access",
    requiresApproval: false,
    description: "Can fetch public online information."
  },
  {
    id: "financial_analysis",
    label: "Financial analysis",
    requiresApproval: false,
    description: "Can analyze markets but cannot place live trades."
  },
  {
    id: "paper_trade",
    label: "Paper trade",
    requiresApproval: true,
    description: "Can simulate trades in non-live environments."
  },
  {
    id: "live_trade",
    label: "Live trade",
    requiresApproval: true,
    description: "Always requires explicit human approval before execution."
  }
];

module.exports = { permissionModes };

