function normalizeTopic(topic) {
  return String(topic || "TerminalX").trim();
}

function normalizePlatform(platform) {
  return String(platform || "general").trim().toLowerCase();
}

function getAudience(payload = {}) {
  return String(payload.audience || "builders, founders, and technical operators").trim();
}

function researchTopicIdeas(payload = {}) {
  const topic = normalizeTopic(payload.topic);
  const audience = getAudience(payload);

  return {
    agent: "content-agent",
    action: "research_topic_ideas",
    topic,
    audience,
    ideas: [
      {
        title: `Why ${topic} matters now`,
        angle: `Explain the timely shift that makes ${topic} relevant for ${audience}.`,
        format: "short educational post"
      },
      {
        title: `${topic} mistakes to avoid`,
        angle: "List common beginner traps and how to sidestep them.",
        format: "carousel or thread"
      },
      {
        title: `Build with ${topic} in public`,
        angle: "Show a practical workflow, decision, or before/after transformation.",
        format: "behind-the-scenes post"
      },
      {
        title: `${topic} checklist`,
        angle: "Turn the topic into an actionable checklist people can save.",
        format: "saveable caption"
      }
    ]
  };
}

function generateScript(payload = {}) {
  const topic = normalizeTopic(payload.topic);
  const platform = normalizePlatform(payload.platform);
  const duration = payload.duration || "60 seconds";

  return {
    agent: "content-agent",
    action: "generate_script",
    topic,
    platform,
    script: [
      `Hook: Most people think ${topic} is complicated. The truth is simpler.`,
      `Context: In the next ${duration}, here is the practical version.`,
      `Point 1: Start with the outcome before choosing tools.`,
      `Point 2: Build one repeatable workflow instead of ten disconnected hacks.`,
      `Point 3: Add review and approval gates before anything risky goes live.`,
      `Close: If you want leverage, make the system easier to trust, not just faster.`
    ].join("\n")
  };
}

function generateCaptions(payload = {}) {
  const topic = normalizeTopic(payload.topic);
  const platform = normalizePlatform(payload.platform);

  return {
    agent: "content-agent",
    action: "generate_captions",
    topic,
    platform,
    captions: [
      `The fastest way to make progress with ${topic}: reduce the number of decisions you need to repeat.`,
      `${topic} works best when the workflow is clear, reviewable, and safe to run again.`,
      `A strong ${topic} system does not just create output. It creates trust in the output.`
    ],
    hashtags: ["#TerminalX", "#AIWorkflows", "#BuildInPublic"]
  };
}

function createPostPlan(payload = {}) {
  const topic = normalizeTopic(payload.topic);
  const platform = normalizePlatform(payload.platform);

  return {
    agent: "content-agent",
    action: "create_post_plan",
    topic,
    platform,
    plan: [
      {
        step: "Research",
        detail: `Collect 3 practical pain points around ${topic}.`
      },
      {
        step: "Draft",
        detail: "Write one hook, three proof points, and one clear takeaway."
      },
      {
        step: "Review",
        detail: "Check claims, tone, and whether the post needs approval before publishing."
      },
      {
        step: "Approval",
        detail: "Submit external posting to the approval queue. Do not post automatically."
      }
    ]
  };
}

function draftPost(payload = {}) {
  const topic = normalizeTopic(payload.topic);
  const platform = normalizePlatform(payload.platform);
  const audience = getAudience(payload);

  return {
    agent: "content-agent",
    action: "draft_post",
    topic,
    platform,
    audience,
    draft: [
      `Most ${audience} do not need more tools for ${topic}.`,
      "",
      "They need a system that makes the next action obvious.",
      "",
      "A good workflow should:",
      "- capture the goal",
      "- route the work to the right agent",
      "- require approval for risky actions",
      "- preserve history and files",
      "- make review easy from mobile",
      "",
      `That is the real promise of ${topic}: less chaos, more accountable execution.`
    ].join("\n")
  };
}

function requestPostingApproval(payload = {}, approvalQueue) {
  const platform = normalizePlatform(payload.platform);
  const content = String(payload.content || payload.draft || "").trim();

  if (!content) {
    throw new Error("content is required before requesting posting approval");
  }

  const approval = approvalQueue.add({
    title: `Approve external post to ${platform}`,
    requestedBy: "content-agent",
    approvalType: "external_posting",
    riskLevel: "medium",
    description: `Content Agent is requesting approval before posting to ${platform}.`,
    proposedAction: {
      tool: "content.post",
      platform,
      content
    }
  });

  return {
    agent: "content-agent",
    action: "request_posting_approval",
    status: "approval_required",
    approval_required: true,
    approval_id: approval.id,
    message: "Posting was not performed. Approval is required first."
  };
}

function runContentAction(payload = {}, approvalQueue) {
  const action = String(payload.action || "draft_post").trim();

  switch (action) {
    case "research":
    case "research_topic_ideas":
      return researchTopicIdeas(payload);
    case "script":
    case "generate_script":
      return generateScript(payload);
    case "caption":
    case "captions":
    case "generate_captions":
      return generateCaptions(payload);
    case "plan":
    case "create_post_plan":
      return createPostPlan(payload);
    case "draft":
    case "draft_post":
      return draftPost(payload);
    case "post":
    case "publish":
    case "request_posting_approval":
      return requestPostingApproval(payload, approvalQueue);
    default:
      throw new Error(`Unsupported content action: ${action}`);
  }
}

module.exports = {
  createPostPlan,
  draftPost,
  generateCaptions,
  generateScript,
  requestPostingApproval,
  researchTopicIdeas,
  runContentAction
};
