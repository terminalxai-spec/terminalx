const MEMORY_CATEGORIES = [
  "project",
  "workflow",
  "coding",
  "content",
  "deployment",
  "user_preference",
  "research"
];

function nowIso() {
  return new Date().toISOString();
}

function normalize(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryKey(category, key) {
  return `${category}:${normalize(key).slice(0, 90) || "general"}`;
}

function scoreMemory(entry, query) {
  const tokens = normalize(query).split(/\s+/).filter(Boolean);
  const haystack = normalize([
    entry.key,
    entry.summary,
    entry.status,
    entry.category,
    JSON.stringify(entry.data || {})
  ].join(" "));
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function createIntelligenceLayer({ repository }) {
  function remember(category, key, data = {}) {
    const safeCategory = MEMORY_CATEGORIES.includes(category) ? category : "project";
    const existing = repository.getSetting?.("memory", memoryKey(safeCategory, key))?.value;
    const entry = {
      id: memoryKey(safeCategory, key),
      category: safeCategory,
      key,
      summary: data.summary || existing?.summary || String(key || "").slice(0, 160),
      status: data.status || existing?.status || "active",
      successes: Number(existing?.successes || 0) + (data.status === "completed" || data.success === true ? 1 : 0),
      failures: Number(existing?.failures || 0) + (data.status === "failed" || data.success === false ? 1 : 0),
      retries: Number(existing?.retries || 0) + Number(data.retries || 0),
      fixes: Array.from(new Set([...(existing?.fixes || []), ...(data.fixes || [])])).slice(-10),
      data: { ...(existing?.data || {}), ...data },
      updatedAt: nowIso(),
      createdAt: existing?.createdAt || nowIso()
    };
    repository.setSetting?.("memory", entry.id, entry);
    return entry;
  }

  function retrieve(query, categories = MEMORY_CATEGORIES, limit = 5) {
    return (repository.listSettings?.("memory") || [])
      .map((setting) => setting.value)
      .filter((entry) => categories.includes(entry.category))
      .map((entry) => ({ entry, score: scoreMemory(entry, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || Date.parse(b.entry.updatedAt || 0) - Date.parse(a.entry.updatedAt || 0))
      .slice(0, limit)
      .map((item) => item.entry);
  }

  function summarize(query, categories) {
    const items = retrieve(query, categories, 5);
    return {
      items,
      summary: items.length
        ? items.map((item) => `${item.category}: ${item.summary} (${item.status})`).join("\n")
        : ""
    };
  }

  function learnFromWorkflow(workflow = {}) {
    const failures = (workflow.timeline || []).filter((event) => event.status === "failed" || event.status === "retrying");
    return remember("workflow", workflow.goal || workflow.name || workflow.id, {
      status: workflow.status,
      summary: `${workflow.name || "Workflow"} ended as ${workflow.status}`,
      workflow_id: workflow.id,
      template_id: workflow.templateId,
      retries: failures.length,
      fixes: (workflow.timeline || []).filter((event) => /fix/i.test(event.status || event.message || "")).map((event) => event.message),
      deployment_result: workflow.context?.deploy || null,
      content_performance: workflow.context?.content?.metadata || null,
      last_timeline: (workflow.timeline || []).slice(-8)
    });
  }

  function buildExecutionContext(goal) {
    const memory = summarize(goal);
    const failed = memory.items.find((entry) => entry.failures > entry.successes && entry.failures > 0);
    return {
      memory,
      avoid_repeated_failure: Boolean(failed),
      avoid_failure_summary: failed ? failed.summary : null,
      decomposed_goal: decomposeGoal(goal)
    };
  }

  function decomposeGoal(goal = "") {
    const text = normalize(goal);
    if (/\b(ai saas|saas|app|website|api)\b/.test(text)) {
      return ["research market and scope", "build MVP", "test workspace output", "prepare deployment"];
    }
    if (/\byoutube|faceless|content business\b/.test(text)) {
      return ["research trend", "generate script", "prepare media package", "hold publishing for approval"];
    }
    if (/\bresearch|pipeline|monitor\b/.test(text)) {
      return ["search latest sources", "fetch and extract", "summarize findings", "save reusable memory"];
    }
    return ["understand goal", "choose workflow", "execute safely", "save learning"];
  }

  function liveDataNeeded(message = "") {
    return /\b(today|latest|current|now|price|rate|weather|news|stock|trend)\b/i.test(message);
  }

  return {
    categories: MEMORY_CATEGORIES,
    remember,
    retrieve,
    summarize,
    learnFromWorkflow,
    buildExecutionContext,
    decomposeGoal,
    liveDataNeeded
  };
}

module.exports = {
  MEMORY_CATEGORIES,
  createIntelligenceLayer
};
