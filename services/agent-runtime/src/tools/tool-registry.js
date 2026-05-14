const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  appendWorkspaceLog,
  createTaskWorkspace,
  listWorkspaceFiles,
  listWorkspaceLogs,
  resolveWorkspacePath
} = require("../workspace/execution-workspace");

const secretPattern = /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]+/gi;
const destructivePattern = /\b(rm\s+-rf|del\s+|remove-item|rmdir|format|shutdown|git\s+reset\s+--hard)\b/i;

function redactSecrets(value = "") {
  return String(value).replace(secretPattern, "$1=[redacted]");
}

function audit(context, toolName, payload = {}) {
  const safePayload = JSON.parse(JSON.stringify(payload, (_key, value) => {
    if (typeof value === "string") return redactSecrets(value);
    return value;
  }));
  context.logAction?.(`tool.${toolName}`, safePayload, context.agentId || null);
  if (context.taskId) {
    context.appendTaskHistory?.(context.taskId, `tool.${toolName}`, safePayload);
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
        const provided = await context.searchProvider?.(query, limit);
        const results = (provided || Array.from({ length: limit }, (_unused, index) => ({
          url: `https://research.local/${encodeURIComponent(query)}/${index + 1}`,
          title: `${query} source ${index + 1}`,
          snippet: `Research source ${index + 1} about ${query}.`
        }))).slice(0, limit);
        const output = { status: "completed", query, results, searchedAt: new Date().toISOString() };
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
        const retries = Math.max(0, Math.min(Number(input.retries ?? 2), 3));
        let lastError = null;
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          try {
            const html = context.fetchPage
              ? await context.fetchPage(input.url, attempt)
              : `<html><title>${input.url}</title><body>Research notes from ${input.url}. This source discusses ${input.url} with useful facts and context.</body></html>`;
            const result = {
              status: "fetched",
              url: input.url,
              title: titleFromHtml(html, input.url),
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
        const failed = { status: "failed", url: input.url, attempts: retries + 1, error: lastError?.message || "Fetch failed" };
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
        const text = stripHtml(input.html || "").slice(0, 3000);
        const result = { status: "extracted", url: input.url, title: input.title || titleFromHtml(input.html, input.url), text };
        audit(context, "text-extract", { ...result, text: `[${text.length} chars]` });
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
        const bullets = documents.map((doc, index) => `- ${doc.title || `Source ${index + 1}`}: ${String(doc.text || "").slice(0, 180)}`);
        const result = {
          status: "summarized",
          query: input.query || "",
          summary: `# Research Summary\n\nTopic: ${input.query || "Research"}\n\n## Findings\n\n${bullets.join("\n") || "- No source text extracted."}\n`,
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
