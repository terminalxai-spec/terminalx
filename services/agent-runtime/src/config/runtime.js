const ONLINE_MODE = "ONLINE_MODE";
const OFFLINE_MODE = "OFFLINE_MODE";

function normalizeRuntimeMode(value) {
  const mode = String(value || ONLINE_MODE).trim().toUpperCase();
  return mode === OFFLINE_MODE ? OFFLINE_MODE : ONLINE_MODE;
}

function getRuntimeConfig() {
  const mode = normalizeRuntimeMode(process.env.TERMINALX_RUNTIME_MODE);
  const llmProvider =
    process.env.LLM_PROVIDER || (mode === OFFLINE_MODE ? "ollama" : "auto");

  return {
    mode,
    isOnlineMode: mode === ONLINE_MODE,
    isOfflineMode: mode === OFFLINE_MODE,
    networkPolicy: mode === OFFLINE_MODE ? "local_only_prepared" : "cloud_api_prepared",
    llm: {
      provider: llmProvider,
      cloudModel: process.env.CLOUD_LLM_MODEL || process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || process.env.GEMINI_MODEL || "not_configured",
      openAiModel: process.env.OPENAI_MODEL || "gpt-5-mini",
      anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      geminiModel: process.env.GEMINI_MODEL || "gemini-2.0-flash",
      groqModel: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      localProvider: process.env.LOCAL_LLM_PROVIDER || "ollama",
      localBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      localModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
      localAiImplemented: true
    },
    storage: {
      provider: process.env.FILE_STORAGE_PROVIDER || process.env.STORAGE_PROVIDER || (mode === OFFLINE_MODE ? "local" : "local"),
      localPath: process.env.FILE_STORAGE_LOCAL_PATH || process.env.STORAGE_LOCAL_PATH || "./storage/local/files"
    }
  };
}

module.exports = {
  OFFLINE_MODE,
  ONLINE_MODE,
  getRuntimeConfig,
  normalizeRuntimeMode
};
