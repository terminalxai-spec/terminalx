async function runResearch({ query, taskId, toolRegistry, limit = 3 }) {
  const search = await toolRegistry.execute("web-search", { query, limit });
  const sources = [];
  const documents = [];

  for (const result of search.results || []) {
    const fetched = await toolRegistry.execute("page-fetch", { url: result.url, retries: 2 });
    const source = {
      url: result.url,
      title: fetched.title || result.title,
      snippet: result.snippet || "",
      status: fetched.status,
      attempts: fetched.attempts || 0,
      fetched_at: fetched.fetchedAt || new Date().toISOString()
    };
    sources.push(source);
    if (fetched.status === "fetched") {
      const extracted = await toolRegistry.execute("text-extract", {
        url: result.url,
        title: source.title,
        html: fetched.html
      });
      documents.push(extracted);
    }
  }

  const summary = await toolRegistry.execute("summarize-content", { query, documents });
  await toolRegistry.execute("output-save", {
    taskId,
    filename: "research-summary.md",
    content: summary.summary
  });
  await toolRegistry.execute("output-save", {
    taskId,
    filename: "sources.json",
    content: JSON.stringify({ query, sources, created_at: new Date().toISOString() }, null, 2)
  });

  return {
    agent: "research-agent",
    action: "research",
    status: documents.length ? "completed" : "failed",
    query,
    summary: summary.summary,
    sources,
    outputs: ["research-summary.md", "sources.json"]
  };
}

module.exports = {
  runResearch
};
