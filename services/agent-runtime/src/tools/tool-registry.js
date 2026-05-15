const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  appendWorkspaceLog,
  appendChangeHistory,
  createTaskWorkspace,
  listChangeHistory,
  listWorkspaceFiles,
  listWorkspaceLogs,
  readWorkspaceFile,
  resolveWorkspacePath
} = require("../workspace/execution-workspace");

const secretPattern = /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]+/gi;
const destructivePattern = /\b(rm\s+-rf|del\s+|remove-item|rmdir|format|shutdown|git\s+reset\s+--hard|npm\s+install\s+-g|pnpm\s+add\s+-g|yarn\s+global|printenv|set\s*$|env\s*$|cat\s+\.env|type\s+\.env)\b/i;

function redactSecrets(value = "") {
  return String(value).replace(secretPattern, "$1=[redacted]");
}

function audit(context, toolName, payload = {}) {
  const safePayload = JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string") return redactSecrets(value);
    return value;
  }));
  try {
    context.logAction?.(`tool.${toolName}`, safePayload, context.agentId || null);
  } catch (error) {
    if (context.taskId) {
      appendWorkspaceLog(context.taskId, "audit-warning", `Audit log failed for ${toolName}: ${error.message}`);
    }
  }
  if (context.taskId) {
    try {
      context.appendTaskHistory?.(context.taskId, `tool.${toolName}`, safePayload);
    } catch (error) {
      appendWorkspaceLog(context.taskId, "history-warning", `Task history log failed for ${toolName}: ${error.message}`);
    }
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

function runCommand(command, cwd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ status: "failed", exitCode: null, stdout: redactSecrets(stdout), stderr: "Command timed out." });
    }, Math.max(1000, Math.min(Number(timeoutMs || 10000), 30000)));
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: "failed", exitCode: null, stdout: redactSecrets(stdout), stderr: redactSecrets(error.message) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ status: exitCode === 0 ? "completed" : "failed", exitCode, stdout: redactSecrets(stdout), stderr: redactSecrets(stderr) });
    });
  });
}

function simpleDiff(before = "", after = "", filePath = "file") {
  const oldLines = String(before).split(/\r?\n/);
  const newLines = String(after).split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const lines = [`--- ${filePath}`, `+++ ${filePath}`];
  for (let index = 0; index < max; index += 1) {
    if (oldLines[index] === newLines[index]) {
      if (oldLines[index] !== undefined) lines.push(` ${oldLines[index]}`);
    } else {
      if (oldLines[index] !== undefined) lines.push(`-${oldLines[index]}`);
      if (newLines[index] !== undefined) lines.push(`+${newLines[index]}`);
    }
  }
  return lines.join("\n");
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFromHtml(html = "", fallback = "Untitled source") {
  return String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || fallback;
}

function assertSafeHttpUrl(rawUrl = "") {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Blocked unsafe protocol.");
  const host = parsed.hostname.toLowerCase();
  if (["localhost", "0.0.0.0"].includes(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Blocked local/internal host.");
  }
  if (net.isIP(host)) {
    const parts = host.split(".").map(Number);
    if (host === "127.0.0.1" || host === "::1" || parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254)) {
      throw new Error("Blocked local/internal network.");
    }
  }
  return parsed.toString();
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(Number(timeoutMs || 8000), 15000)));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSearchResults(items = [], limit = 3) {
  return items
    .map((item) => ({
      url: item.url || item.link,
      title: stripHtml(item.title || item.name || item.url || "Untitled source").slice(0, 160),
      snippet: stripHtml(item.snippet || item.description || item.content || "").slice(0, 300)
    }))
    .filter((item) => {
      try {
        item.url = assertSafeHttpUrl(item.url);
        return true;
      } catch {
        return false;
      }
    })
    .slice(0, limit);
}

function curatedSearchFallback(query = "", limit = 3) {
  const normalized = String(query).toLowerCase();
  const sources = [];
  if (/gold|silver|bullion/.test(normalized)) {
    sources.push(
      { url: "https://www.goodreturns.in/gold-rates/mumbai.html", title: "Mumbai Gold Rate - Goodreturns", snippet: "Live gold rate page for Mumbai with daily updates." },
      { url: "https://www.bankbazaar.com/gold-rate-mumbai.html", title: "Gold Rate in Mumbai - BankBazaar", snippet: "Mumbai gold price reference with market context." }
    );
  }
  if (/weather|temperature|forecast/.test(normalized)) {
    sources.push(
      { url: `https://wttr.in/${encodeURIComponent(query.replace(/weather|temperature|forecast|today/gi, "").trim() || "Mumbai")}`, title: "Weather forecast - wttr.in", snippet: "Public weather forecast endpoint." }
    );
  }
  if (/ai|startup|coding|technology|news/.test(normalized)) {
    sources.push(
      { url: "https://www.theverge.com/ai-artificial-intelligence", title: "AI News - The Verge", snippet: "Current AI news and analysis." },
      { url: "https://techcrunch.com/category/artificial-intelligence/", title: "Artificial Intelligence - TechCrunch", snippet: "AI startup and technology coverage." }
    );
  }
  return normalizeSearchResults(sources, limit);
}

async function providerWebSearch(query, limit, fetchImpl) {
  const provider = String(process.env.WEB_SEARCH_PROVIDER || "").toLowerCase();
  if (provider === "serper" && process.env.SERPER_API_KEY) {
    const response = await fetchWithTimeout(fetchImpl, "https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: limit })
    });
    if (!response.ok) throw new Error(`Serper search failed: ${response.status}`);
    const data = await response.json();
    return normalizeSearchResults(data.organic || data.news || [], limit);
  }
  if (provider === "tavily" && process.env.TAVILY_API_KEY) {
    const response = await fetchWithTimeout(fetchImpl, "https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: limit })
    });
    if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
    const data = await response.json();
    return normalizeSearchResults(data.results || [], limit);
  }
  if (provider === "brave" && process.env.BRAVE_SEARCH_API_KEY) {
    const response = await fetchWithTimeout(fetchImpl, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, {
      headers: { accept: "application/json", "x-subscription-token": process.env.BRAVE_SEARCH_API_KEY }
    });
    if (!response.ok) throw new Error(`Brave search failed: ${response.status}`);
    const data = await response.json();
    return normalizeSearchResults(data.web?.results || [], limit);
  }
  try {
    const response = await fetchWithTimeout(fetchImpl, `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "user-agent": "TerminalX/1.0" }
    }, 5000);
    if (!response.ok) throw new Error(`DuckDuckGo search failed: ${response.status}`);
    const html = await response.text();
    const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi)];
    const results = normalizeSearchResults(matches.map((match) => {
      const url = decodeURIComponent(String(match[1]).replace(/^\/l\/\?kh=-1&uddg=/, ""));
      return { url, title: match[2], snippet: match[3] || "" };
    }), limit);
    return results.length ? results : curatedSearchFallback(query, limit);
  } catch (error) {
    const fallback = curatedSearchFallback(query, limit);
    if (fallback.length) return fallback;
    throw new Error(`Live web search unavailable: ${error.name === "AbortError" ? "search timed out" : error.message}`);
  }
}

function friendlyFetchError(error) {
  if (error?.name === "AbortError" || /abort|timed out|timeout/i.test(error?.message || "")) {
    return "Live page fetch timed out.";
  }
  return error?.message || "Fetch failed";
}

function extractReadableHtml(html = "", fallbackTitle = "") {
  const title = stripHtml(titleFromHtml(html, fallbackTitle)).slice(0, 160);
  const metadata = {
    description: stripHtml(String(html).match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] || "")
  };
  const headings = [...String(html).matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((match) => stripHtml(match[1])).filter(Boolean).slice(0, 12);
  const paragraphs = [...String(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripHtml(match[1])).filter((text) => text.length > 25).slice(0, 20);
  const text = [...headings, ...paragraphs].join("\n").slice(0, 5000) || stripHtml(html).slice(0, 5000);
  return { title, metadata, headings, paragraphs, text };
}

function providerRequired(name) {
  throw new Error(`${name} provider is not configured on the server.`);
}

async function withRetries(action, retries = 2) {
  const limit = Math.max(0, Math.min(Number(retries ?? 2), 3));
  let lastError = null;
  for (let attempt = 1; attempt <= limit + 1; attempt += 1) {
    try {
      return { attempts: attempt, value: await action(attempt) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Generation failed");
}

function cleanTopic(value = "") {
  return String(value || "AI workflow").replace(/\s+/g, " ").trim();
}

function titleCase(value = "") {
  return cleanTopic(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contentTags(topic = "") {
  const base = cleanTopic(topic).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 5);
  return Array.from(new Set([...base, "ai", "automation", "terminalx"])).slice(0, 8);
}

function escapeXml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scriptToSubtitles(script = "") {
  const sentences = String(script).replace(/[#*_`>-]/g, " ").split(/[.!?\n]+/).map((entry) => entry.trim()).filter(Boolean).slice(0, 8);
  return sentences.map((sentence, index) => {
    const start = String(index * 4).padStart(2, "0");
    const end = String(index * 4 + 3).padStart(2, "0");
    return `${index + 1}\n00:00:${start},000 --> 00:00:${end},500\n${sentence}`;
  }).join("\n\n") || "1\n00:00:00,000 --> 00:00:03,500\nTerminalX video package generated.";
}

function browserActionNeedsApproval(input = {}) {
  const text = `${input.action || ""} ${input.selector || ""} ${input.text || ""} ${input.url || ""}`.toLowerCase();
  return /\b(login|sign in|signin|submit|purchase|buy|checkout|upload|delete|remove|destroy|confirm)\b/.test(text);
}

function createToolRegistry(context = {}) {
  const browserSessions = context.browserSessions || new Map();
  const tools = {
    "web-search": {
      name: "web-search",
      description: "Find lightweight web sources for a research topic.",
      inputSchema: { query: "string", limit: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const query = String(input.query || "TerminalX research").trim();
        const limit = Math.max(1, Math.min(Number(input.limit || 3), 5));
        const fetchImpl = context.fetchImpl || globalThis.fetch;
        if (!fetchImpl && !context.searchProvider) throw new Error("No web search provider or fetch implementation configured.");
        const provided = await context.searchProvider?.(query, limit);
        const results = normalizeSearchResults(provided || await providerWebSearch(query, limit, fetchImpl), limit);
        const output = { status: results.length ? "completed" : "failed", query, results, searchedAt: new Date().toISOString() };
        audit(context, "web-search", output);
        return output;
      }
    },
    "page-fetch": {
      name: "page-fetch",
      description: "Fetch a source page with retry handling.",
      inputSchema: { url: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const safeUrl = assertSafeHttpUrl(input.url);
        const fetchImpl = context.fetchImpl || globalThis.fetch;
        const retries = Math.max(0, Math.min(Number(input.retries ?? 2), 3));
        let lastError = null;
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          try {
            const html = context.fetchPage
              ? await context.fetchPage(safeUrl, attempt)
              : await fetchWithTimeout(fetchImpl, safeUrl, { headers: { "user-agent": "TerminalX/1.0" } }, input.timeoutMs).then(async (response) => {
                  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
                  return response.text();
                });
            const result = {
              status: "fetched",
              url: safeUrl,
              title: titleFromHtml(html, safeUrl),
              html,
              attempts: attempt,
              fetchedAt: new Date().toISOString()
            };
            audit(context, "page-fetch", { ...result, html: `[${html.length} chars]` });
            return result;
          } catch (error) {
            lastError = error;
          }
        }
        const failed = { status: "failed", url: input.url, attempts: retries + 1, error: friendlyFetchError(lastError) };
        audit(context, "page-fetch", failed);
        return failed;
      }
    },
    "text-extract": {
      name: "text-extract",
      description: "Extract readable text from fetched page HTML.",
      inputSchema: { html: "string", url: "string", title: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const extracted = extractReadableHtml(input.html || "", input.title || input.url);
        const result = { status: "extracted", url: input.url, title: input.title || extracted.title, ...extracted };
        audit(context, "text-extract", { ...result, text: `[${result.text.length} chars]` });
        return result;
      }
    },
    "summarize-content": {
      name: "summarize-content",
      description: "Summarize extracted research content with source tracking.",
      inputSchema: { query: "string", documents: "array" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const documents = input.documents || [];
        const sourceBullets = documents.map((doc, index) => `- ${doc.title || `Source ${index + 1}`}: ${String(doc.text || "").slice(0, 220)}\n  Source: ${doc.url || "unknown"}`);
        const prompt = `Query: ${input.query}\n\nSources:\n${sourceBullets.join("\n")}`;
        const llmText = context.llmProvider?.sendMessage
          ? await context.llmProvider.sendMessage({
              system: "Summarize live web research concisely. Include factual caveats and cite source titles/URLs from the provided text.",
              message: prompt,
              temperature: 0.2,
              maxTokens: 700
            }).then((result) => result.text || result.content || "").catch(() => "")
          : "";
        const result = {
          status: "summarized",
          query: input.query || "",
          summary: llmText || `# Research Summary\n\nTopic: ${input.query || "Research"}\n\n## Findings\n\n${sourceBullets.join("\n") || "- No source text extracted."}\n`,
          sourceCount: documents.length,
          summarizedAt: new Date().toISOString()
        };
        audit(context, "summarize-content", result);
        return result;
      }
    },
    "generate-title": {
      name: "generate-title",
      description: "Generate a content title from topic, format, and research context.",
      inputSchema: { topic: "string", format: "string", research: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const topic = cleanTopic(input.topic);
        const generated = await withRetries(
          () => context.contentProvider?.generateTitle?.(input) || `${titleCase(topic)}: A Practical ${titleCase(input.format || "Guide")}`,
          input.retries
        );
        const result = { status: "generated", title: generated.value, attempts: generated.attempts };
        audit(context, "generate-title", result);
        return result;
      }
    },
    "generate-description": {
      name: "generate-description",
      description: "Generate a searchable content description.",
      inputSchema: { topic: "string", format: "string", title: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const topic = cleanTopic(input.topic);
        const generated = await withRetries(
          () => context.contentProvider?.generateDescription?.(input) || `A clear, practical ${input.format || "content"} package about ${topic}, built for operators who want useful steps, examples, and safe execution.`,
          input.retries
        );
        const result = { status: "generated", description: generated.value, attempts: generated.attempts };
        audit(context, "generate-description", result);
        return result;
      }
    },
    "generate-tags": {
      name: "generate-tags",
      description: "Generate tags for content discovery.",
      inputSchema: { topic: "string", format: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.contentProvider?.generateTags?.(input) || contentTags(input.topic),
          input.retries
        );
        const result = { status: "generated", tags: generated.value, attempts: generated.attempts };
        audit(context, "generate-tags", result);
        return result;
      }
    },
    "generate-thumbnail-prompt": {
      name: "generate-thumbnail-prompt",
      description: "Generate a thumbnail image prompt.",
      inputSchema: { topic: "string", title: "string", format: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const topic = cleanTopic(input.topic);
        const generated = await withRetries(
          () => context.contentProvider?.generateThumbnailPrompt?.(input) || `Premium dark tech thumbnail for "${input.title || topic}", glowing cyan TerminalX command center, readable central subject, no clutter.`,
          input.retries
        );
        const result = { status: "generated", prompt: generated.value, attempts: generated.attempts };
        audit(context, "generate-thumbnail-prompt", result);
        return result;
      }
    },
    "generate-script": {
      name: "generate-script",
      description: "Generate a structured script from topic, outline, and research notes.",
      inputSchema: { topic: "string", format: "string", outline: "array", research: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const topic = cleanTopic(input.topic);
        const outline = input.outline?.length ? input.outline : ["Hook", "Problem", "Useful workflow", "Example", "Call to action"];
        const fallback = [
          `# ${titleCase(topic)}`,
          "",
          `Format: ${input.format || "content package"}`,
          "",
          ...outline.map((item, index) => `## ${index + 1}. ${item}\nExplain ${item.toLowerCase()} for ${topic} with one practical takeaway.`),
          "",
          "## Source Notes",
          input.research || "No external research attached."
        ].join("\n");
        const generated = await withRetries(
          () => context.contentProvider?.generateScript?.(input) || fallback,
          input.retries
        );
        const result = { status: "generated", script: generated.value, attempts: generated.attempts };
        audit(context, "generate-script", { ...result, script: `[${String(generated.value).length} chars]` });
        return result;
      }
    },
    "generate-voiceover-script": {
      name: "generate-voiceover-script",
      description: "Generate a spoken voiceover script.",
      inputSchema: { topic: "string", script: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const topic = cleanTopic(input.topic);
        const generated = await withRetries(
          () => context.contentProvider?.generateVoiceoverScript?.(input) || `Voiceover: Today we are breaking down ${topic}. Start with the outcome, show the workflow, then finish with the safest next action.`,
          input.retries
        );
        const result = { status: "generated", voiceover: generated.value, attempts: generated.attempts };
        audit(context, "generate-voiceover-script", result);
        return result;
      }
    },
    "generate-image": {
      name: "generate-image",
      description: "Generate a lightweight SVG image asset from a thumbnail prompt.",
      inputSchema: { prompt: "string", title: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const title = titleCase(input.title || "TerminalX");
        const generated = await withRetries(
          () => context.contentProvider?.generateImage?.(input) || [
            `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">`,
            `<rect width="1280" height="720" fill="#050914"/>`,
            `<rect x="64" y="64" width="1152" height="592" rx="28" fill="#071827" stroke="#35d8f4" stroke-width="4"/>`,
            `<text x="96" y="210" fill="#35d8f4" font-family="Arial" font-size="42" font-weight="700">TerminalX Content</text>`,
            `<text x="96" y="340" fill="#ffffff" font-family="Arial" font-size="72" font-weight="700">${escapeXml(title).slice(0, 56)}</text>`,
            `<text x="96" y="465" fill="#9fb4cc" font-family="Arial" font-size="30">${escapeXml(input.prompt || "").slice(0, 95)}</text>`,
            `</svg>`
          ].join(""),
          input.retries
        );
        const result = { status: "generated", filename: "thumbnail.svg", mimeType: "image/svg+xml", content: generated.value, attempts: generated.attempts };
        audit(context, "generate-image", { status: result.status, filename: result.filename, attempts: result.attempts });
        return result;
      }
    },
    "generate-voice": {
      name: "generate-voice",
      description: "Generate narration audio from a script and save it in workspace outputs.",
      inputSchema: { taskId: "string", script: "string", filename: "string", voice: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.mediaProvider?.generateVoice?.(input) || `TERMINALX_MP3_EXPORT\nvoice=${input.voice || "default"}\nchars=${String(input.script || "").length}\n${String(input.script || "").slice(0, 500)}`,
          input.retries
        );
        const filename = input.filename || "narration.mp3";
        await tools["output-save"].execute({ taskId: input.taskId || context.taskId, filename, content: generated.value });
        const result = { status: "generated", path: filename, durationSeconds: Math.max(3, Math.ceil(String(input.script || "").length / 14)), attempts: generated.attempts };
        audit(context, "generate-voice", result);
        return result;
      }
    },
    "generate-subtitles": {
      name: "generate-subtitles",
      description: "Generate SRT subtitles from a script and save them in workspace outputs.",
      inputSchema: { taskId: "string", script: "string", filename: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.mediaProvider?.generateSubtitles?.(input) || scriptToSubtitles(input.script),
          input.retries
        );
        const filename = input.filename || "subtitles.srt";
        await tools["output-save"].execute({ taskId: input.taskId || context.taskId, filename, content: generated.value });
        const result = { status: "generated", path: filename, cueCount: String(generated.value).split(/\n\n+/).filter(Boolean).length, attempts: generated.attempts };
        audit(context, "generate-subtitles", result);
        return result;
      }
    },
    "assemble-video": {
      name: "assemble-video",
      description: "Assemble narration, subtitles, images, and transitions into a render manifest.",
      inputSchema: { taskId: "string", narrationPath: "string", subtitlesPath: "string", images: "array", transitions: "array", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.mediaProvider?.assembleVideo?.(input) || {
            timeline: [
              { type: "image", source: input.images?.[0] || "generated-images/thumbnail.svg", transition: input.transitions?.[0] || "fade" },
              { type: "audio", source: input.narrationPath || "narration.mp3" },
              { type: "subtitles", source: input.subtitlesPath || "subtitles.srt" }
            ],
            logs: ["Loaded generated image", "Aligned narration", "Applied subtitles", "Prepared render manifest"]
          },
          input.retries
        );
        await tools["output-save"].execute({ taskId: input.taskId || context.taskId, filename: "render-logs.txt", content: generated.value.logs.join("\n") });
        const result = { status: "assembled", timeline: generated.value.timeline, renderLogs: "render-logs.txt", attempts: generated.attempts };
        audit(context, "assemble-video", result);
        return result;
      }
    },
    "merge-audio-video": {
      name: "merge-audio-video",
      description: "Merge assembled video timeline with narration into an exported video file.",
      inputSchema: { taskId: "string", assembly: "object", narrationPath: "string", filename: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.mediaProvider?.mergeAudioVideo?.(input) || `TERMINALX_MP4_EXPORT\nnarration=${input.narrationPath || "narration.mp3"}\ntracks=${input.assembly?.timeline?.length || 0}`,
          input.retries
        );
        const filename = input.filename || "final-video.mp4";
        await tools["output-save"].execute({ taskId: input.taskId || context.taskId, filename, content: generated.value });
        const result = { status: "merged", path: filename, attempts: generated.attempts };
        audit(context, "merge-audio-video", result);
        return result;
      }
    },
    "export-video-package": {
      name: "export-video-package",
      description: "Export video package metadata for download/review.",
      inputSchema: { taskId: "string", videoPath: "string", narrationPath: "string", subtitlesPath: "string", metadata: "object", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const generated = await withRetries(
          () => context.mediaProvider?.exportVideoPackage?.(input) || ({
            status: "exported",
            video: input.videoPath || "final-video.mp4",
            narration: input.narrationPath || "narration.mp3",
            subtitles: input.subtitlesPath || "subtitles.srt",
            metadata: input.metadata || {},
            exportedAt: new Date().toISOString()
          }),
          input.retries
        );
        await tools["output-save"].execute({ taskId: input.taskId || context.taskId, filename: "video-package.json", content: JSON.stringify(generated.value, null, 2) });
        const result = { status: "exported", path: "video-package.json", package: generated.value, attempts: generated.attempts };
        audit(context, "export-video-package", result);
        return result;
      }
    },
    "github-create-repo": {
      name: "github-create-repo",
      description: "Create a GitHub repository through a server-side provider.",
      inputSchema: { name: "string", private: "boolean" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.githubProvider?.createRepo?.(input) || providerRequired("GitHub"));
        audit(context, "github-create-repo", { repoUrl: result.repoUrl, repo: result.repo });
        return { status: "created", ...result };
      }
    },
    "github-write-files": {
      name: "github-write-files",
      description: "Stage workspace files for a GitHub repository through a server-side provider.",
      inputSchema: { repo: "string", taskId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const files = listWorkspaceFiles(input.taskId || context.taskId).map((file) => ({
          ...file,
          content: fs.readFileSync(resolveWorkspacePath(input.taskId || context.taskId, "files", file.path).resolved, "utf8")
        }));
        const result = await (context.githubProvider?.writeFiles?.({ ...input, files }) || providerRequired("GitHub"));
        audit(context, "github-write-files", { repo: input.repo, fileCount: files.length });
        return { status: "written", fileCount: files.length, ...result };
      }
    },
    "github-commit": {
      name: "github-commit",
      description: "Create a GitHub commit through a server-side provider.",
      inputSchema: { repo: "string", message: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.githubProvider?.commit?.(input) || providerRequired("GitHub"));
        audit(context, "github-commit", { repo: input.repo, commitSha: result.commitSha });
        return { status: "committed", ...result };
      }
    },
    "github-push": {
      name: "github-push",
      description: "Push code to GitHub through a server-side provider.",
      inputSchema: { repo: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("GitHub push requires human/admin approval.");
        }
        const result = await (context.githubProvider?.push?.(input) || providerRequired("GitHub"));
        audit(context, "github-push", { repo: input.repo, pushed: true });
        return { status: "pushed", ...result };
      }
    },
    "deploy-vercel": {
      name: "deploy-vercel",
      description: "Deploy workspace output through a server-side deployment provider.",
      inputSchema: { repo: "string", taskId: "string", approvalId: "string", retries: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Deployment requires human/admin approval.");
        }
        const retries = Math.max(0, Math.min(Number(input.retries ?? 2), 3));
        let lastError = null;
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          try {
            const result = await (context.deploymentProvider?.deploy?.({ ...input, attempt }) || providerRequired("Deployment"));
            audit(context, "deploy-vercel", { deploymentUrl: result.deploymentUrl, attempt });
            return { status: "deployed", attempts: attempt, ...result };
          } catch (error) {
            lastError = error;
          }
        }
        const failed = { status: "failed", attempts: retries + 1, error: lastError?.message || "Deployment failed" };
        audit(context, "deploy-vercel", failed);
        return failed;
      }
    },
    "deployment-status": {
      name: "deployment-status",
      description: "Read deployment status through a server-side deployment provider.",
      inputSchema: { deploymentId: "string", deploymentUrl: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.deploymentProvider?.status?.(input) || providerRequired("Deployment"));
        audit(context, "deployment-status", { deploymentId: input.deploymentId, status: result.status });
        return result;
      }
    },
    "browser-open": {
      name: "browser-open",
      description: "Open a URL in an isolated browser session.",
      inputSchema: { url: "string", sessionId: "string", retries: "number", timeoutMs: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const sessionId = input.sessionId || `browser_${Date.now()}`;
        const retries = Math.max(0, Math.min(Number(input.retries ?? 2), 3));
        let lastError = null;
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          try {
            const result = await (context.browserProvider?.open?.({ ...input, sessionId, attempt }) || providerRequired("Browser"));
            browserSessions.set(sessionId, { sessionId, url: input.url, openedAt: new Date().toISOString() });
            audit(context, "browser-open", { sessionId, url: input.url, attempt });
            appendWorkspaceLog(context.taskId || sessionId, "browser", `open ${input.url}`);
            return { status: "opened", sessionId, attempts: attempt, ...result };
          } catch (error) {
            lastError = error;
          }
        }
        return { status: "failed", sessionId, attempts: retries + 1, error: lastError?.message || "Browser open failed" };
      }
    },
    "browser-click": {
      name: "browser-click",
      description: "Click an element in an isolated browser session.",
      inputSchema: { sessionId: "string", selector: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        if (browserActionNeedsApproval(input) && (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId))) {
          throw new Error("Sensitive browser click requires human/admin approval.");
        }
        const result = await (context.browserProvider?.click?.(input) || providerRequired("Browser"));
        audit(context, "browser-click", { sessionId: input.sessionId, selector: input.selector });
        appendWorkspaceLog(context.taskId || input.sessionId, "browser", `click ${input.selector}`);
        return { status: "clicked", ...result };
      }
    },
    "browser-type": {
      name: "browser-type",
      description: "Type text into an element in an isolated browser session.",
      inputSchema: { sessionId: "string", selector: "string", text: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        if (browserActionNeedsApproval(input) && (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId))) {
          throw new Error("Sensitive browser typing requires human/admin approval.");
        }
        const result = await (context.browserProvider?.type?.(input) || providerRequired("Browser"));
        audit(context, "browser-type", { sessionId: input.sessionId, selector: input.selector, text: "[redacted]" });
        appendWorkspaceLog(context.taskId || input.sessionId, "browser", `type ${input.selector}`);
        return { status: "typed", ...result };
      }
    },
    "browser-screenshot": {
      name: "browser-screenshot",
      description: "Capture a browser screenshot and save it to workspace outputs.",
      inputSchema: { sessionId: "string", filename: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.browserProvider?.screenshot?.(input) || providerRequired("Browser"));
        const filename = input.filename || `browser-${input.sessionId || "session"}.txt`;
        await tools["output-save"].execute({
          taskId: context.taskId || input.sessionId,
          filename,
          content: result.content || result.screenshot || ""
        });
        audit(context, "browser-screenshot", { sessionId: input.sessionId, filename });
        return { status: "captured", filename, ...result };
      }
    },
    "browser-extract-text": {
      name: "browser-extract-text",
      description: "Extract visible text from a browser session and save it to workspace outputs.",
      inputSchema: { sessionId: "string", filename: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.browserProvider?.extractText?.(input) || providerRequired("Browser"));
        const filename = input.filename || `browser-text-${input.sessionId || "session"}.txt`;
        await tools["output-save"].execute({
          taskId: context.taskId || input.sessionId,
          filename,
          content: result.text || ""
        });
        audit(context, "browser-extract-text", { sessionId: input.sessionId, filename });
        return { status: "extracted", filename, ...result };
      }
    },
    "browser-close": {
      name: "browser-close",
      description: "Close an isolated browser session.",
      inputSchema: { sessionId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const result = await (context.browserProvider?.close?.(input) || providerRequired("Browser"));
        browserSessions.delete(input.sessionId);
        audit(context, "browser-close", { sessionId: input.sessionId });
        appendWorkspaceLog(context.taskId || input.sessionId, "browser", `close ${input.sessionId}`);
        return { status: "closed", ...result };
      }
    },
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
    "file-explorer": {
      name: "file-explorer",
      description: "List workspace files for project chat explorer.",
      inputSchema: { taskId: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const files = listWorkspaceFiles(input.taskId || context.taskId);
        const result = { status: "listed", files };
        audit(context, "file-explorer", result);
        return result;
      }
    },
    "file-preview": {
      name: "file-preview",
      description: "Preview a workspace file for project chat.",
      inputSchema: { taskId: "string", path: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const content = readWorkspaceFile(input.taskId || context.taskId, input.path).slice(0, 12000);
        const result = { status: "previewed", path: input.path, content };
        audit(context, "file-preview", { status: result.status, path: result.path });
        return result;
      }
    },
    "workspace-file-list": {
      name: "workspace-file-list",
      description: "List files in the active project workspace.",
      inputSchema: { taskId: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        return tools["file-explorer"].execute(input);
      }
    },
    "workspace-file-preview": {
      name: "workspace-file-preview",
      description: "Preview a file in the active project workspace.",
      inputSchema: { taskId: "string", path: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        return tools["file-preview"].execute(input);
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
    "file-propose": {
      name: "file-propose",
      description: "Create a before/after diff and approval request for workspace file changes.",
      inputSchema: { taskId: "string", path: "string", content: "string", delete: "boolean" },
      permissionRequired: "files:upload",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        const { resolved } = resolveWorkspacePath(input.taskId, "files", input.path);
        const before = fs.existsSync(resolved) ? fs.readFileSync(resolved, "utf8") : "";
        const isDelete = Boolean(input.delete);
        const after = isDelete ? "" : String(input.content || "");
        const diff = simpleDiff(before, after, input.path);
        const status = isDelete ? "deleted" : before ? "modified" : "added";
        const approval = context.approvalQueue?.add({
          taskId: input.taskId,
          title: `Approve changes to ${input.path}`,
          approvalType: "repo_modification",
          riskLevel: "medium",
          requestedBy: "terminalx",
          description: `Approve before applying changes to ${input.path}.`,
          proposedAction: {
            tool: "file-edit",
            files: [{ path: input.path, before, after, diff, status, deleted: isDelete }],
            diff
          }
        });
        appendChangeHistory(input.taskId, {
          approvalId: approval?.id,
          status: "pending",
          files: [{ path: input.path, before, after, diff, status, deleted: isDelete }],
          testResult: input.testResult || null
        });
        const result = { status: "waiting_approval", message: "Changes ready for review", approvalId: approval?.id, path: input.path, diff };
        audit(context, "file-propose", result);
        return result;
      }
    },
    "file-apply-approved": {
      name: "file-apply-approved",
      description: "Apply approved file diffs inside the workspace.",
      inputSchema: { taskId: "string", approvalId: "string" },
      permissionRequired: "files:upload",
      riskLevel: "medium",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Applying file changes requires approval.");
        }
        const approval = context.approvalQueue.get(input.approvalId);
        const files = approval?.proposedAction?.files || [];
        const changed = [];
        for (const file of files) {
          const { resolved } = resolveWorkspacePath(input.taskId || approval.taskId, "files", file.path);
          if (file.deleted) {
            if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
            changed.push({ path: file.path, status: "deleted", diff: file.diff });
          } else {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, file.after || "", "utf8");
            changed.push({ path: file.path, status: file.status || (file.before ? "modified" : "added"), diff: file.diff });
          }
        }
        appendChangeHistory(input.taskId || approval.taskId, {
          approvalId: input.approvalId,
          status: "accepted",
          files: changed.map((file) => {
            const original = files.find((entry) => entry.path === file.path) || {};
            return { ...file, before: original.before || "", after: original.after || "", deleted: Boolean(original.deleted) };
          }),
          testResult: input.testResult || null
        });
        const result = { status: "applied", files: changed };
        audit(context, "file-apply-approved", result);
        return result;
      }
    },
    "file-reject-change": {
      name: "file-reject-change",
      description: "Mark a proposed change as rejected without applying it.",
      inputSchema: { taskId: "string", approvalId: "string" },
      permissionRequired: "files:upload",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const approval = context.approvalQueue?.decide?.(input.approvalId, "rejected", "terminalx");
        const result = { status: "rejected", approvalId: input.approvalId };
        appendChangeHistory(input.taskId || approval?.taskId || context.taskId, {
          approvalId: input.approvalId,
          status: "rejected",
          files: approval?.proposedAction?.files || []
        });
        audit(context, "file-reject-change", result);
        return result;
      }
    },
    "file-rollback": {
      name: "file-rollback",
      description: "Rollback the last accepted file change in the workspace.",
      inputSchema: { taskId: "string", changeId: "string" },
      permissionRequired: "files:upload",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const taskId = input.taskId || context.taskId;
        const history = listChangeHistory(taskId);
        const change = input.changeId
          ? history.find((entry) => entry.approvalId === input.changeId || entry.createdAt === input.changeId)
          : history.find((entry) => entry.status === "accepted");
        if (!change) throw new Error("No accepted change found to rollback.");
        for (const file of change.files || []) {
          const { resolved } = resolveWorkspacePath(taskId, "files", file.path);
          if (file.status === "added" || (!file.before && !file.deleted)) {
            if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
          } else if (file.before) {
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, file.before, "utf8");
          } else if (fs.existsSync(resolved)) {
            fs.unlinkSync(resolved);
          }
        }
        const result = { status: "rolled_back", files: (change.files || []).map((file) => file.path) };
        appendChangeHistory(taskId, { status: "rolled_back", rollbackOf: change.approvalId || change.createdAt, files: change.files || [] });
        audit(context, "file-rollback", result);
        return result;
      }
    },
    "change-history": {
      name: "change-history",
      description: "List project change history.",
      inputSchema: { taskId: "string" },
      permissionRequired: "files:read",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const result = { status: "listed", changes: listChangeHistory(input.taskId || context.taskId) };
        audit(context, "change-history", { status: result.status, count: result.changes.length });
        return result;
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
    "terminal-run": {
      name: "terminal-run",
      description: "Run a safe terminal command inside the workspace only.",
      inputSchema: { taskId: "string", command: "array", approvalId: "string", timeoutMs: "number" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        const command = Array.isArray(input.command) ? input.command.map(String) : String(input.command || "").trim().split(/\s+/);
        if (destructivePattern.test(command.join(" "))) throw new Error("Destructive command blocked.");
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Terminal command requires approval.");
        }
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        const result = await runCommand(command, workspace.filesDir, input.timeoutMs);
        audit(context, "terminal-run", { command: command.join(" "), ...result });
        return result;
      }
    },
    "git-status": {
      name: "git-status",
      description: "Read git status inside the workspace.",
      inputSchema: { taskId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        const result = await runCommand(["git", "status", "--short"], workspace.filesDir, input.timeoutMs || 10000);
        audit(context, "git-status", result);
        return result;
      }
    },
    "git-diff": {
      name: "git-diff",
      description: "Read git diff inside the workspace.",
      inputSchema: { taskId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "low",
      approvalRequired: false,
      async execute(input) {
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        const result = await runCommand(["git", "diff"], workspace.filesDir, input.timeoutMs || 10000);
        audit(context, "git-diff", result);
        return result;
      }
    },
    "git-commit": {
      name: "git-commit",
      description: "Commit workspace changes locally.",
      inputSchema: { taskId: "string", message: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        await runCommand(["git", "add", "."], workspace.filesDir, input.timeoutMs || 10000);
        const result = await runCommand(["git", "commit", "-m", input.message || "TerminalX workspace update"], workspace.filesDir, input.timeoutMs || 10000);
        audit(context, "git-commit", result);
        return result;
      }
    },
    "git-branch": {
      name: "git-branch",
      description: "Create or switch a git branch inside the workspace.",
      inputSchema: { taskId: "string", branch: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "medium",
      approvalRequired: false,
      async execute(input) {
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        const result = await runCommand(["git", "checkout", "-B", input.branch || "terminalx-work"], workspace.filesDir, input.timeoutMs || 10000);
        audit(context, "git-branch", result);
        return result;
      }
    },
    "git-push": {
      name: "git-push",
      description: "Push workspace branch to remote. Requires approval.",
      inputSchema: { taskId: "string", remote: "string", branch: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Git push requires human/admin approval.");
        }
        const { workspace } = resolveWorkspacePath(input.taskId, "files", "");
        const result = await runCommand(["git", "push", input.remote || "origin", input.branch || "HEAD"], workspace.filesDir, input.timeoutMs || 30000);
        audit(context, "git-push", result);
        return result;
      }
    },
    "git-pr-create": {
      name: "git-pr-create",
      description: "Create a pull request through a server provider. Requires approval.",
      inputSchema: { taskId: "string", approvalId: "string" },
      permissionRequired: "agents:execute",
      riskLevel: "high",
      approvalRequired: true,
      async execute(input) {
        if (!input.approvalId || !context.approvalQueue?.isApproved(input.approvalId)) {
          throw new Error("Pull request creation requires human/admin approval.");
        }
        const result = await (context.githubProvider?.createPr?.(input) || providerRequired("GitHub"));
        audit(context, "git-pr-create", { url: result.url });
        return { status: "created", ...result };
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
