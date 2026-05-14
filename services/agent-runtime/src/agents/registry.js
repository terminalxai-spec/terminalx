// The agent registry is the first stable contract for TerminalX agents. It is
// intentionally data-first so the dashboard, API, and future runtime can share
// the same source of truth.
const agentRegistry = [
  {
    id: "ceo-agent",
    name: "CEO Agent",
    type: "ceo",
    status: "available",
    defaultModel: "claude-opus-4-6",
    responsibilities: [
      "Understand user goals",
      "Create task plans",
      "Assign specialist agents",
      "Review final outputs"
    ],
    permissions: ["read_only", "task_manage", "approval_request"]
  },
  {
    id: "coding-agent",
    name: "Coding Agent",
    type: "coding",
    status: "available",
    defaultModel: "claude-sonnet-4-6",
    responsibilities: ["Read code", "Edit files", "Run development commands"],
    permissions: ["read_only", "workspace_write", "code_execution"]
  },
  {
    id: "testing-agent",
    name: "Testing Agent",
    type: "testing",
    status: "available",
    defaultModel: "claude-sonnet-4-6",
    responsibilities: ["Run tests", "Validate builds", "Report regressions"],
    permissions: ["read_only", "code_execution"]
  },
  {
    id: "content-agent",
    name: "Content Agent",
    type: "content",
    status: "available",
    defaultModel: "claude-sonnet-4-6",
    responsibilities: ["Research ideas", "Generate scripts", "Draft captions and posts"],
    permissions: ["read_only", "file_storage_write", "approval_request"]
  },
  {
    id: "trading-agent",
    name: "Trading Agent",
    type: "trading",
    status: "guarded",
    defaultModel: "claude-opus-4-6",
    responsibilities: ["Analyze market data", "Create watchlists", "Draft risk-limited trade plans"],
    permissions: ["read_only", "internet_access", "financial_analysis"]
  },
  {
    id: "chat-agent",
    name: "Chat Agent",
    type: "chat",
    status: "available",
    defaultModel: "claude-haiku-4-5-20251213",
    responsibilities: ["Answer questions", "Route lightweight requests", "Summarize tasks"],
    permissions: ["read_only"]
  },
  {
    id: "research-agent",
    name: "Research Agent",
    type: "research",
    status: "available",
    defaultModel: "groq-llama-3.3-70b-versatile",
    responsibilities: ["Search web sources", "Fetch pages", "Summarize findings"],
    permissions: ["read_only", "internet_access"]
  }
];

module.exports = { agentRegistry };
