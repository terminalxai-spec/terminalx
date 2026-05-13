const { getRuntimeConfig, OFFLINE_MODE } = require("../config/runtime");

const allowedIntents = new Set(["coding", "testing", "content", "trading", "chat"]);

function hasValue(value) {
  return Boolean(String(value || "").trim());
}

function compactText(value, limit = 4000) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function sanitizeProviderError(provider, status, body) {
  const text = compactText(body, 220);
  if (/invalid|api.?key|unauthorized|forbidden|token|secret/i.test(text)) {
    return `${provider} request failed: ${status} authentication rejected`;
  }
  return `${provider} request failed: ${status} ${text}`;
}

function extractOpenAiText(payload) {
  if (payload.output_text) {
    return payload.output_text;
  }

  const parts = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractAnthropicText(payload) {
  return (payload.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractGeminiText(payload) {
  return (payload.candidates || [])
    .flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => part.text || "")
    .join("\n")
    .trim();
}

function extractChatCompletionText(payload) {
  return (payload.choices || [])
    .map((choice) => choice.message?.content || "")
    .join("\n")
    .trim();
}

function extractOllamaText(payload) {
  return String(payload.message?.content || payload.response || "").trim();
}

function parseIntentFromText(text) {
  const raw = String(text || "").trim();
  try {
    const parsed = JSON.parse(raw);
    const intent = String(parsed.intent || "").toLowerCase();
    if (allowedIntents.has(intent)) {
      return intent;
    }
  } catch {
    // Fall through to text matching.
  }

  const match = raw.toLowerCase().match(/\b(coding|testing|content|trading|chat)\b/);
  return match ? match[1] : "chat";
}

async function timedFetch(url, options = {}, timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 10000)) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`AI provider request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

class BaseLlmProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  async streamMessage(payload = {}) {
    const result = await this.sendMessage(payload);
    return {
      provider: result.provider,
      mode: result.mode,
      chunks: [result.text]
    };
  }

  async classifyIntent(command) {
    const prompt = [
      "Classify this TerminalX command into exactly one intent.",
      "Allowed intents: coding, testing, content, trading, chat.",
      "Return only JSON like {\"intent\":\"coding\"}.",
      `Command: ${command}`
    ].join("\n");
    const result = await this.sendMessage({
      system: "You are the TerminalX CEO Agent intent classifier.",
      message: prompt,
      temperature: 0,
      maxTokens: 80
    });
    return {
      intent: parseIntentFromText(result.text),
      provider: this.id,
      raw: result.text
    };
  }

  async summarizeFile({ filename, content }) {
    return this.sendMessage({
      system: "Summarize uploaded files for TerminalX. Be concise and practical.",
      message: [`File: ${filename || "uploaded file"}`, compactText(content, 8000)].join("\n\n"),
      temperature: 0.2,
      maxTokens: 500
    });
  }
}

class MockLlmProvider extends BaseLlmProvider {
  constructor(config, reason = "No API key configured.") {
    super(config);
    this.id = "mock";
    this.reason = reason;
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: "mock",
      available: true,
      note: `Demo AI mode active. ${this.reason}`
    };
  }

  async sendMessage(payload = {}) {
    return {
      provider: this.id,
      mode: this.config.mode,
      text: [
        "TerminalX demo AI response.",
        `Prompt: ${compactText(payload.message || payload.prompt || "", 500)}`
      ].join("\n")
    };
  }

  async classifyIntent(command) {
    const normalized = String(command || "").toLowerCase();
    const rules = [
      { intent: "trading", keywords: ["trade", "trading", "stock", "crypto", "forex", "buy", "sell", "portfolio", "market", "btc", "eth"] },
      { intent: "testing", keywords: ["test", "tests", "qa", "verify", "validate", "regression", "coverage", "bug"] },
      { intent: "coding", keywords: ["code", "build", "create", "make", "implement", "fix", "refactor", "api", "app", "calculator", "backend", "frontend", "database", "component"] },
      { intent: "content", keywords: ["write", "draft", "blog", "post", "copy", "docs", "readme", "article", "content", "tweet", "caption", "script", "ideas"] }
    ];
    const match = rules.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
    return {
      intent: match?.intent || "chat",
      provider: this.id,
      raw: "mock_rule_classifier"
    };
  }
}

class OpenAiProvider extends BaseLlmProvider {
  constructor(config) {
    super(config);
    this.id = "openai";
    this.model = process.env.OPENAI_MODEL || process.env.CLOUD_LLM_MODEL || "gpt-5-mini";
    this.apiKey = process.env.OPENAI_API_KEY;
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: hasValue(this.apiKey) ? "ready" : "missing_api_key",
      available: hasValue(this.apiKey),
      model: this.model
    };
  }

  async sendMessage(payload = {}) {
    if (!hasValue(this.apiKey)) {
      return new MockLlmProvider(this.config, "OPENAI_API_KEY is missing.").sendMessage(payload);
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        instructions: payload.system || "You are TerminalX.",
        input: payload.message || payload.prompt || "",
        temperature: payload.temperature,
        max_output_tokens: payload.maxTokens || 800
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      provider: this.id,
      mode: this.config.mode,
      model: this.model,
      text: extractOpenAiText(data)
    };
  }
}

class AnthropicProvider extends BaseLlmProvider {
  constructor(config) {
    super(config);
    this.id = "anthropic";
    this.model = process.env.ANTHROPIC_MODEL || process.env.CLOUD_LLM_MODEL || "claude-sonnet-4-5";
    this.apiKey = process.env.ANTHROPIC_API_KEY;
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: hasValue(this.apiKey) ? "ready" : "missing_api_key",
      available: hasValue(this.apiKey),
      model: this.model
    };
  }

  async sendMessage(payload = {}) {
    if (!hasValue(this.apiKey)) {
      return new MockLlmProvider(this.config, "ANTHROPIC_API_KEY is missing.").sendMessage(payload);
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        system: payload.system || "You are TerminalX.",
        max_tokens: payload.maxTokens || 800,
        temperature: payload.temperature,
        messages: [{ role: "user", content: payload.message || payload.prompt || "" }]
      })
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      provider: this.id,
      mode: this.config.mode,
      model: this.model,
      text: extractAnthropicText(data)
    };
  }
}

class GeminiProvider extends BaseLlmProvider {
  constructor(config) {
    super(config);
    this.id = "gemini";
    this.model = process.env.GEMINI_MODEL || process.env.CLOUD_LLM_MODEL || "gemini-2.0-flash";
    this.apiKey = process.env.GEMINI_API_KEY;
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: hasValue(this.apiKey) ? "ready" : "missing_api_key",
      available: hasValue(this.apiKey),
      model: this.model
    };
  }

  async sendMessage(payload = {}) {
    if (!hasValue(this.apiKey)) {
      return new MockLlmProvider(this.config, "GEMINI_API_KEY is missing.").sendMessage(payload);
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: payload.system || "You are TerminalX." }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: payload.message || payload.prompt || "" }]
          }
        ],
        generationConfig: {
          temperature: payload.temperature,
          maxOutputTokens: payload.maxTokens || 800
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      provider: this.id,
      mode: this.config.mode,
      model: this.model,
      text: extractGeminiText(data)
    };
  }
}

class GroqProvider extends BaseLlmProvider {
  constructor(config) {
    super(config);
    this.id = "groq";
    this.model = process.env.GROQ_MODEL || process.env.CLOUD_LLM_MODEL || "llama-3.3-70b-versatile";
    this.apiKey = process.env.GROQ_API_KEY;
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: hasValue(this.apiKey) ? "ready" : "missing_api_key",
      available: hasValue(this.apiKey),
      model: this.model,
      baseUrl: "https://api.groq.com/openai/v1"
    };
  }

  async sendMessage(payload = {}) {
    if (!hasValue(this.apiKey)) {
      return new MockLlmProvider(this.config, "GROQ_API_KEY is missing.").sendMessage(payload);
    }

    const response = await timedFetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: payload.system || "You are TerminalX."
            },
            {
              role: "user",
              content: payload.message || payload.prompt || ""
            }
          ],
          temperature: payload.temperature,
          max_completion_tokens: payload.maxTokens || 500
        })
      },
      payload.timeoutMs || Number(process.env.LLM_TIMEOUT_MS || 10000)
    );

    if (!response.ok) {
      throw new Error(sanitizeProviderError("Groq", response.status, await response.text()));
    }

    const data = await response.json();
    return {
      provider: this.id,
      mode: this.config.mode,
      model: this.model,
      text: extractChatCompletionText(data)
    };
  }
}

class OllamaProvider extends BaseLlmProvider {
  constructor(config) {
    super(config);
    this.id = "ollama";
    this.baseUrl = process.env.OLLAMA_BASE_URL || config.llm.localBaseUrl || "http://127.0.0.1:11434";
    this.model = process.env.OLLAMA_MODEL || config.llm.localModel || "llama3.1:8b";
  }

  describe() {
    return {
      id: this.id,
      mode: this.config.mode,
      status: "local_configured",
      available: true,
      baseUrl: this.baseUrl,
      model: this.model,
      note: "Ollama local AI provider is configured. If the model is missing, run ollama pull for this model."
    };
  }

  async sendMessage(payload = {}) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: "system",
            content: payload.system || "You are TerminalX."
          },
          {
            role: "user",
            content: payload.message || payload.prompt || ""
          }
        ],
        options: {
          temperature: payload.temperature ?? 0.2,
          num_predict: payload.maxTokens || 800
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
    }

    const data = await response.json();
    return {
      provider: this.id,
      mode: this.config.mode,
      model: this.model,
      text: extractOllamaText(data)
    };
  }
}

function selectConfiguredCloudProvider(config) {
  const preferred = String(config.llm.provider || "auto").toLowerCase();
  const providers = {
    openai: () => new OpenAiProvider(config),
    anthropic: () => new AnthropicProvider(config),
    gemini: () => new GeminiProvider(config),
    groq: () => new GroqProvider(config),
    ollama: () => new OllamaProvider(config),
    mock: () => new MockLlmProvider(config)
  };

  if (providers[preferred]) {
    return providers[preferred]();
  }

  if (hasValue(process.env.OPENAI_API_KEY)) {
    return new OpenAiProvider(config);
  }
  if (hasValue(process.env.ANTHROPIC_API_KEY)) {
    return new AnthropicProvider(config);
  }
  if (hasValue(process.env.GEMINI_API_KEY)) {
    return new GeminiProvider(config);
  }
  if (hasValue(process.env.GROQ_API_KEY)) {
    return new GroqProvider(config);
  }
  return new MockLlmProvider(config);
}

function createLlmProvider(config = getRuntimeConfig()) {
  if (config.mode === OFFLINE_MODE) {
    return new OllamaProvider(config);
  }
  return selectConfiguredCloudProvider(config);
}

module.exports = {
  AnthropicProvider,
  BaseLlmProvider,
  GeminiProvider,
  GroqProvider,
  MockLlmProvider,
  OllamaProvider,
  OpenAiProvider,
  createLlmProvider,
  parseIntentFromText
};
