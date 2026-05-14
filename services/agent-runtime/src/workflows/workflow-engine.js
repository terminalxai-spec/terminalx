const { createToolRegistry } = require("../tools/tool-registry");
const researchAgent = require("../agents/research-agent");

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const workflowTemplates = [
  {
    id: "youtube-automation",
    name: "YouTube Automation",
    description: "Research topic, draft script, prepare description, and pause before posting.",
    steps: [
      { id: "research", type: "integration", target: "web-search", input: { query: "{{topic}}" } },
      { id: "script", type: "agent", target: "content-agent", dependsOn: ["research"] },
      { id: "approval", type: "approval", target: "external_posting", dependsOn: ["script"] }
    ]
  },
  {
    id: "app-builder",
    name: "App Builder",
    description: "Plan app, ask for file-write approval, generate files, and run tests.",
    steps: [
      { id: "plan", type: "agent", target: "ceo-agent" },
      { id: "code", type: "agent", target: "coding-agent", dependsOn: ["plan"], approvalRequired: true },
      { id: "test", type: "agent", target: "testing-agent", dependsOn: ["code"] }
    ]
  },
  {
    id: "deploy-app",
    name: "Build And Deploy App",
    description: "Build app, test app, approve release, create GitHub repo, push code, deploy, and return live URL.",
    steps: [
      { id: "plan", type: "agent", target: "ceo-agent" },
      { id: "code", type: "agent", target: "coding-agent", dependsOn: ["plan"], approvalRequired: true },
      { id: "release_approval", type: "approval", target: "deployment_release", dependsOn: ["code"] },
      { id: "repo", type: "tool", target: "github-create-repo", dependsOn: ["release_approval"] },
      { id: "write", type: "tool", target: "github-write-files", dependsOn: ["repo"] },
      { id: "commit", type: "tool", target: "github-commit", dependsOn: ["write"] },
      { id: "push", type: "tool", target: "github-push", dependsOn: ["commit"] },
      { id: "deploy", type: "tool", target: "deploy-vercel", dependsOn: ["push"] },
      { id: "status", type: "tool", target: "deployment-status", dependsOn: ["deploy"] }
    ]
  },
  {
    id: "research-workflow",
    name: "Research Workflow",
    description: "Search, summarize, save notes, and produce a task-ready brief.",
    steps: [
      { id: "search", type: "integration", target: "web-search" },
      { id: "summarize", type: "agent", target: "chat-agent", dependsOn: ["search"] },
      { id: "save", type: "tool", target: "output-save", dependsOn: ["summarize"] }
    ]
  },
  {
    id: "browser-workflow",
    name: "Browser Automation",
    description: "Open a page, capture screenshot, extract text, and close the isolated browser session.",
    steps: [
      { id: "browse", type: "agent", target: "browser-agent", input: { url: "{{url}}" } }
    ]
  },
  {
    id: "content-pipeline",
    name: "Content Pipeline",
    description: "Generate ideas, scripts, captions, and approval-ready posts.",
    steps: [
      { id: "ideas", type: "agent", target: "content-agent" },
      { id: "draft", type: "agent", target: "content-agent", dependsOn: ["ideas"] },
      { id: "approval", type: "approval", target: "external_posting", dependsOn: ["draft"] }
    ]
  },
  {
    id: "youtube-video",
    name: "YouTube Video",
    description: "Research a topic, create a script, metadata, thumbnail prompt, and pause before upload.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "youtube video" } },
      { id: "upload_approval", type: "approval", target: "external_upload", dependsOn: ["content"] }
    ]
  },
  {
    id: "faceless-youtube-video",
    name: "Faceless YouTube Video",
    description: "Research, script, metadata, thumbnail, narration, subtitles, video assembly, and export package before upload approval.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "faceless youtube video" } },
      { id: "media", type: "agent", target: "media-agent", dependsOn: ["content"] },
      { id: "upload_approval", type: "approval", target: "external_upload", dependsOn: ["media"] }
    ]
  },
  {
    id: "blog-article",
    name: "Blog Article",
    description: "Research, outline, draft, prepare SEO metadata, and pause before publishing.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "blog article" } },
      { id: "publish_approval", type: "approval", target: "publishing", dependsOn: ["content"] }
    ]
  },
  {
    id: "twitter-thread",
    name: "Twitter/X Thread",
    description: "Create a concise thread package and pause before social posting.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "twitter thread" } },
      { id: "post_approval", type: "approval", target: "social_posting", dependsOn: ["content"] }
    ]
  },
  {
    id: "instagram-reel-plan",
    name: "Instagram Reel Plan",
    description: "Create reel script, voiceover, caption metadata, and pause before posting.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "instagram reel" } },
      { id: "post_approval", type: "approval", target: "social_posting", dependsOn: ["content"] }
    ]
  },
  {
    id: "ai-news-summary",
    name: "AI News Summary",
    description: "Research AI news, summarize findings, and save a reusable content package.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "content", type: "agent", target: "content-agent", dependsOn: ["research"], input: { format: "ai news summary" } }
    ]
  },
  {
    id: "lead-generation",
    name: "Lead Generation",
    description: "Research leads, draft outreach, and stop before sending externally.",
    steps: [
      { id: "research", type: "integration", target: "web-search" },
      { id: "draft", type: "agent", target: "content-agent", dependsOn: ["research"] },
      { id: "approval", type: "approval", target: "external_posting", dependsOn: ["draft"] }
    ]
  }
];

const integrations = [
  { id: "gmail", name: "Gmail", status: "placeholder", approvalRequired: true, description: "Draft email workflows. Sending requires approval." },
  { id: "github", name: "GitHub", status: "available", approvalRequired: true, description: "Server-side repository creation, file writes, commits, and approved pushes." },
  { id: "youtube", name: "YouTube", status: "placeholder", approvalRequired: true, description: "Content planning only. Publishing requires approval." },
  { id: "google-drive", name: "Google Drive", status: "placeholder", approvalRequired: true, description: "File planning placeholder." },
  { id: "web-search", name: "Web Search", status: "available", approvalRequired: false, description: "Search, fetch, extract, summarize, and save sources." }
];

function settingList(repository, scope) {
  return repository.listSettings?.(scope).map((setting) => setting.value) || [];
}

function saveSetting(repository, scope, key, value) {
  repository.setSetting?.(scope, key, value);
  return value;
}

function dependenciesComplete(step, stepStates) {
  return (step.dependsOn || []).every((dependency) => stepStates[dependency]?.status === "completed");
}

function createWorkflowEngine({ repository, approvalQueue, appendTaskHistory, createTask, executeCodingTask, toolRegistryFactory, workflowTimeoutMs = 30000, maxConcurrentWorkflows = 1 }) {
  let activeTicks = 0;

  function log(action, payload = {}) {
    repository.logAction?.(`workflow.${action}`, payload, "workflow-engine");
  }

  function listWorkflows() {
    return settingList(repository, "workflows").sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function getWorkflow(id) {
    return repository.getSetting?.("workflows", id)?.value || null;
  }

  function saveWorkflow(workflow) {
    workflow.updatedAt = nowIso();
    return saveSetting(repository, "workflows", workflow.id, workflow);
  }

  function createWorkflow(payload = {}) {
    const template = workflowTemplates.find((entry) => entry.id === payload.template_id);
    const steps = payload.steps || template?.steps || [];
    const workflow = {
      id: payload.id || createId("workflow"),
      name: payload.name || template?.name || "Untitled workflow",
      goal: payload.goal || template?.description || "",
      status: "created",
      templateId: payload.template_id || template?.id || null,
      schedule: payload.schedule || null,
      botId: payload.bot_id || null,
      retryLimit: Number(payload.retry_limit ?? 2),
      steps: steps.map((step, index) => ({
        id: step.id || `step_${index + 1}`,
        type: step.type || "agent",
        target: step.target || step.agent || "chat-agent",
        input: step.input || {},
        dependsOn: step.dependsOn || [],
        approvalRequired: Boolean(step.approvalRequired || step.approval_required),
        retryCount: 0,
        status: "pending"
      })),
      context: payload.context || {},
      timeline: [{ status: "planning", message: "Workflow created", createdAt: nowIso() }],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    saveWorkflow(workflow);
    log("created", { workflowId: workflow.id, name: workflow.name });
    return workflow;
  }

  function queueJob(workflow) {
    const job = {
      id: createId("job"),
      workflowId: workflow.id,
      status: "queued",
      attempts: 0,
      startedAt: null,
      heartbeatAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    saveSetting(repository, "worker_jobs", job.id, job);
    log("job_queued", { workflowId: workflow.id, jobId: job.id });
    return job;
  }

  function startWorkflow(id) {
    const workflow = typeof id === "string" ? getWorkflow(id) : id;
    if (!workflow) throw new Error("Workflow not found.");
    workflow.status = "queued";
    workflow.timeline.push({ status: "queued", message: "Workflow queued for background worker", createdAt: nowIso() });
    saveWorkflow(workflow);
    const job = queueJob(workflow);
    return { workflow, job };
  }

  function listJobs() {
    return settingList(repository, "worker_jobs").sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  }

  function saveJob(job) {
    job.updatedAt = nowIso();
    job.heartbeatAt = nowIso();
    return saveSetting(repository, "worker_jobs", job.id, job);
  }

  function failWorkflow(workflow, job, message) {
    const currentStep = workflow.steps.find((step) => step.status === "running");
    if (currentStep) {
      currentStep.status = "failed";
      currentStep.error = message;
    }
    workflow.status = "failed";
    job.status = "failed";
    job.error = message;
    workflow.timeline.push({ status: "failed", step: currentStep?.id, message, createdAt: nowIso() });
    saveWorkflow(workflow);
    saveJob(job);
    log("failed", { workflowId: workflow.id, jobId: job.id, error: message });
    return { status: "failed", workflow, activeJob: job };
  }

  function withTimeout(promise, ms) {
    if (!ms || ms <= 0) return promise;
    let timer;
    return Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Workflow step timed out after ${ms}ms`)), ms);
      })
    ]).finally(() => clearTimeout(timer));
  }

  function stepStates(workflow) {
    return Object.fromEntries(workflow.steps.map((step) => [step.id, step]));
  }

  function taskIdForWorkflow(workflow) {
    return workflow.context.code?.task_id || workflow.steps.find((step) => step.taskId)?.taskId || `workflow-${workflow.id}`;
  }

  function toolInputForStep(workflow, step) {
    const repo = workflow.context.repo?.repo || workflow.context.repo?.repoName || workflow.context.repo?.name || workflow.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const deployment = workflow.context.deploy || {};
    return {
      ...(step.input || {}),
      taskId: step.input?.taskId || taskIdForWorkflow(workflow),
      name: step.input?.name || repo,
      repo,
      repoUrl: workflow.context.repo?.repoUrl,
      message: step.input?.message || `TerminalX deploy ${workflow.name}`,
      approvalId: step.input?.approvalId || workflow.context.release_approval_id,
      deploymentId: deployment.deploymentId,
      deploymentUrl: deployment.deploymentUrl
    };
  }

  function executeStep(workflow, step) {
    step.status = "running";
    workflow.status = "running";
    workflow.timeline.push({ status: "executing", step: step.id, message: `${step.target} started`, createdAt: nowIso() });

    if (step.type === "agent" && step.target === "coding-agent" && typeof createTask === "function" && typeof executeCodingTask === "function") {
      workflow.timeline.push({ status: "planned", step: step.id, message: "Coding task planned", createdAt: nowIso() });
      const task = createTask({
        title: `${workflow.name}: coding task`,
        description: workflow.goal || step.input?.command || workflow.name,
        assignedAgentId: "coding-agent",
        intent: "coding",
        status: "assigned",
        metadata: {
          ...(step.input || {}),
          workflow_id: workflow.id,
          workflow_step_id: step.id,
          requirements: step.input?.requirements || workflow.context.requirements || []
        }
      });
      appendTaskHistory?.(task.id, "workflow.task_created", { workflow_id: workflow.id, step_id: step.id });
      const result = executeCodingTask({
        task,
        command: step.input?.command || workflow.goal || workflow.name,
        approvalQueue
      });
      step.output = { task_id: task.id, ...result };
      workflow.context[step.id] = step.output;
      if (result.approval_required) {
        step.status = "waiting_approval";
        step.approvalId = result.approval_id;
        step.taskId = task.id;
        workflow.status = "waiting_approval";
        workflow.timeline.push({ status: "waiting_approval", step: step.id, message: `Coding Agent is waiting for approval: ${result.approval_id}`, createdAt: nowIso() });
        return;
      }
      step.status = "completed";
      workflow.timeline.push({ status: "completed", step: step.id, message: "Coding Agent completed", createdAt: nowIso() });
      return;
    }

    if (step.type === "integration" && step.target === "web-search") {
      const query = step.input?.query && !String(step.input.query).includes("{{")
        ? step.input.query
        : workflow.context.topic || workflow.goal || workflow.name;
      const taskId = `workflow-${workflow.id}`;
      const toolRegistry = toolRegistryFactory
        ? toolRegistryFactory(taskId, "research-agent")
        : createToolRegistry({
            taskId,
            agentId: "research-agent",
            approvalQueue,
            logAction: repository.logAction?.bind(repository),
            appendTaskHistory
          });
      return researchAgent.runResearch({ query, taskId, toolRegistry, limit: step.input?.limit || 3 }).then((result) => {
        step.status = result.status;
        step.output = result;
        workflow.context[step.id] = result;
        workflow.context.research = result;
        workflow.timeline.push({ status: result.status, step: step.id, message: `Research completed with ${result.sources.length} source(s)`, createdAt: nowIso() });
      });
    }

    if (step.type === "agent" && step.target === "browser-agent") {
      const taskId = `workflow-${workflow.id}`;
      const sessionId = `session-${workflow.id}-${step.id}`;
      const url = step.input?.url && !String(step.input.url).includes("{{")
        ? step.input.url
        : workflow.context.url || workflow.goal;
      const toolRegistry = toolRegistryFactory
        ? toolRegistryFactory(taskId, "browser-agent")
        : createToolRegistry({
            taskId,
            agentId: "browser-agent",
            approvalQueue,
            logAction: repository.logAction?.bind(repository),
            appendTaskHistory
          });
      return Promise.resolve()
        .then(() => toolRegistry.execute("browser-open", { url, sessionId, retries: step.input?.retries ?? 2 }))
        .then((opened) => toolRegistry.execute("browser-screenshot", { sessionId, filename: "browser-screenshot.txt" }).then((screenshot) => ({ opened, screenshot })))
        .then((state) => toolRegistry.execute("browser-extract-text", { sessionId, filename: "browser-text.txt" }).then((extracted) => ({ ...state, extracted })))
        .then((state) => toolRegistry.execute("browser-close", { sessionId }).then((closed) => ({ ...state, closed })))
        .then((result) => {
          step.status = "completed";
          step.output = { status: "completed", sessionId, url, ...result };
          workflow.context[step.id] = step.output;
          workflow.timeline.push({ status: "completed", step: step.id, message: `Browser Agent extracted ${String(result.extracted.text || "").length} chars`, createdAt: nowIso() });
        });
    }

    if (step.type === "agent" && step.target === "content-agent") {
      const taskId = `workflow-${workflow.id}`;
      const topic = step.input?.topic || workflow.context.topic || workflow.goal || workflow.name;
      const format = step.input?.format || workflow.context.format || workflow.templateId || "content package";
      const research = workflow.context.research?.summary || workflow.context.search?.summary || "";
      const sources = workflow.context.research?.sources || workflow.context.search?.sources || [];
      const outline = [
        "Hook the audience with the core problem",
        "Explain why the topic matters now",
        "Show a practical workflow or example",
        "Summarize the safest next action"
      ];
      const toolRegistry = toolRegistryFactory
        ? toolRegistryFactory(taskId, "content-agent")
        : createToolRegistry({
            taskId,
            agentId: "content-agent",
            approvalQueue,
            logAction: repository.logAction?.bind(repository),
            appendTaskHistory
          });
      return Promise.resolve()
        .then(() => toolRegistry.execute("generate-title", { topic, format, research, retries: step.input?.retries ?? 2 }))
        .then((title) => toolRegistry.execute("generate-description", { topic, format, title: title.title, retries: step.input?.retries ?? 2 }).then((description) => ({ title, description })))
        .then((state) => toolRegistry.execute("generate-tags", { topic, format, retries: step.input?.retries ?? 2 }).then((tags) => ({ ...state, tags })))
        .then((state) => toolRegistry.execute("generate-script", { topic, format, outline, research, retries: step.input?.retries ?? 2 }).then((script) => ({ ...state, script })))
        .then((state) => toolRegistry.execute("generate-thumbnail-prompt", { topic, format, title: state.title.title, retries: step.input?.retries ?? 2 }).then((thumbnailPrompt) => ({ ...state, thumbnailPrompt })))
        .then((state) => toolRegistry.execute("generate-image", { title: state.title.title, prompt: state.thumbnailPrompt.prompt, retries: step.input?.retries ?? 2 }).then((image) => ({ ...state, image })))
        .then((state) => toolRegistry.execute("generate-voiceover-script", { topic, script: state.script.script, retries: step.input?.retries ?? 2 }).then((voiceover) => ({ ...state, voiceover })))
        .then(async (state) => {
          const metadata = {
            title: state.title.title,
            description: state.description.description,
            tags: state.tags.tags,
            format,
            topic,
            sources,
            generatedAt: nowIso()
          };
          const contentPackage = {
            metadata,
            script: "script.md",
            thumbnailPrompt: "thumbnail-prompt.txt",
            image: "generated-images/thumbnail.svg",
            voiceover: state.voiceover.voiceover
          };
          await toolRegistry.execute("output-save", { taskId, filename: "script.md", content: state.script.script });
          await toolRegistry.execute("output-save", { taskId, filename: "metadata.json", content: JSON.stringify(metadata, null, 2) });
          await toolRegistry.execute("output-save", { taskId, filename: "thumbnail-prompt.txt", content: state.thumbnailPrompt.prompt });
          await toolRegistry.execute("output-save", { taskId, filename: "generated-images/thumbnail.svg", content: state.image.content });
          await toolRegistry.execute("output-save", { taskId, filename: "content-package.json", content: JSON.stringify(contentPackage, null, 2) });
          step.status = "completed";
          step.output = { status: "completed", taskId, metadata, contentPackage, script: state.script.script, imagePath: "generated-images/thumbnail.svg" };
          workflow.context[step.id] = step.output;
          workflow.context.content = step.output;
          workflow.timeline.push({ status: "completed", step: step.id, message: `Content package generated for ${format}`, createdAt: nowIso() });
        });
    }

    if (step.type === "agent" && step.target === "media-agent") {
      const taskId = `workflow-${workflow.id}`;
      const content = workflow.context.content || {};
      const script = content.script || workflow.context.topic || workflow.goal || workflow.name;
      const metadata = content.metadata || { title: workflow.name };
      const imagePath = content.imagePath || "generated-images/thumbnail.svg";
      const toolRegistry = toolRegistryFactory
        ? toolRegistryFactory(taskId, "media-agent")
        : createToolRegistry({
            taskId,
            agentId: "media-agent",
            approvalQueue,
            logAction: repository.logAction?.bind(repository),
            appendTaskHistory
          });
      return Promise.resolve()
        .then(() => toolRegistry.execute("generate-voice", { taskId, script, filename: "narration.mp3", retries: step.input?.retries ?? 2 }))
        .then((voice) => toolRegistry.execute("generate-subtitles", { taskId, script, filename: "subtitles.srt", retries: step.input?.retries ?? 2 }).then((subtitles) => ({ voice, subtitles })))
        .then((state) => toolRegistry.execute("assemble-video", {
          taskId,
          narrationPath: state.voice.path,
          subtitlesPath: state.subtitles.path,
          images: [imagePath],
          transitions: ["fade", "cut"],
          retries: step.input?.retries ?? 2
        }).then((assembly) => ({ ...state, assembly })))
        .then((state) => toolRegistry.execute("merge-audio-video", {
          taskId,
          assembly: state.assembly,
          narrationPath: state.voice.path,
          filename: "final-video.mp4",
          retries: step.input?.retries ?? 2
        }).then((video) => ({ ...state, video })))
        .then((state) => toolRegistry.execute("export-video-package", {
          taskId,
          videoPath: state.video.path,
          narrationPath: state.voice.path,
          subtitlesPath: state.subtitles.path,
          metadata,
          retries: step.input?.retries ?? 2
        }).then((videoPackage) => ({ ...state, videoPackage })))
        .then((result) => {
          step.status = "completed";
          step.output = { status: "completed", taskId, ...result };
          workflow.context[step.id] = step.output;
          workflow.context.media = step.output;
          workflow.timeline.push({ status: "completed", step: step.id, message: "Voice and video package exported", createdAt: nowIso() });
        });
    }

    if (step.approvalRequired || step.type === "approval") {
      const approval = approvalQueue.add({
        title: `Approve workflow step: ${workflow.name} / ${step.id}`,
        approvalType: step.target || "workflow_step",
        riskLevel: step.type === "approval" ? "high" : "medium",
        requestedBy: "workflow-engine",
        description: `Workflow ${workflow.name} is waiting for approval before ${step.target} continues.`,
        proposedAction: {
          workflow_id: workflow.id,
          step_id: step.id,
          tool: step.target,
          input: step.input || {}
        }
      });
      step.status = "waiting_approval";
      step.approvalId = approval.id;
      workflow.status = "waiting_approval";
      workflow.timeline.push({ status: "waiting_approval", step: step.id, message: `Approval required: ${approval.id}`, createdAt: nowIso() });
      return;
    }

    if (step.type === "tool") {
      const taskId = taskIdForWorkflow(workflow);
      const toolRegistry = toolRegistryFactory
        ? toolRegistryFactory(taskId, "workflow-engine")
        : createToolRegistry({
            taskId,
            agentId: "workflow-engine",
            approvalQueue,
            logAction: repository.logAction?.bind(repository),
            appendTaskHistory
          });
      return toolRegistry.execute(step.target, toolInputForStep(workflow, step)).then((result) => {
        step.status = result.status === "failed" ? "failed" : "completed";
        step.output = result;
        workflow.context[step.id] = result;
        if (step.target === "github-create-repo") workflow.context.repo = result;
        if (step.target === "deploy-vercel") workflow.context.deploy = result;
        workflow.timeline.push({ status: step.status, step: step.id, message: `${step.target} ${step.status}`, createdAt: nowIso() });
      });
    }

    const output = step.type === "agent" && step.target === "chat-agent" && workflow.context.research
      ? {
          target: step.target,
          type: step.type,
          message: "Research summary prepared for handoff.",
          summary: workflow.context.research.summary,
          sources: workflow.context.research.sources
        }
      : {
      target: step.target,
      type: step.type,
      message: `${step.target} completed by workflow engine.`,
      input: step.input || {}
    };
    step.status = "completed";
    step.output = output;
    workflow.context[step.id] = output;
    workflow.timeline.push({ status: "completed", step: step.id, message: `${step.target} completed`, createdAt: nowIso() });

  }

  function resumeCodingTask(task, result = {}) {
    const workflowId = task?.metadata?.workflow_id;
    const stepId = task?.metadata?.workflow_step_id;
    const workflow = workflowId ? getWorkflow(workflowId) : null;
    if (!workflow || !stepId) return null;

    const step = workflow.steps.find((entry) => entry.id === stepId);
    if (!step) return null;

    workflow.timeline.push({ status: "running", step: step.id, message: "Approval received. Coding Agent resumed.", createdAt: nowIso() });
    for (const phase of result.logs || []) {
      if (["generating", "testing", "fixing", "retesting", "completed", "failed"].includes(phase)) {
        workflow.timeline.push({ status: phase, step: step.id, message: `Coding Agent ${phase}`, createdAt: nowIso() });
      }
    }
    step.status = result.status === "failed" ? "failed" : "completed";
    step.output = { ...(step.output || {}), ...result };
    workflow.context[step.id] = step.output;

    const states = stepStates(workflow);
    workflow.steps
      .filter((entry) => entry.status === "pending" && entry.type === "agent" && entry.target === "testing-agent" && dependenciesComplete(entry, states))
      .forEach((entry) => {
        entry.status = result.status === "failed" ? "failed" : "completed";
        entry.output = { status: result.test_result?.status || result.status, message: "Testing completed during Coding Agent execution.", task_id: task.id };
        workflow.context[entry.id] = entry.output;
        workflow.timeline.push({ status: entry.status, step: entry.id, message: entry.output.message, createdAt: nowIso() });
      });

    workflow.status = workflow.steps.some((entry) => entry.status === "failed")
      ? "failed"
      : workflow.steps.every((entry) => entry.status === "completed")
        ? "completed"
        : "running";
    workflow.timeline.push({ status: workflow.status, message: workflow.status === "completed" ? "Workflow completed" : "Workflow updated", createdAt: nowIso() });
    saveWorkflow(workflow);

    listJobs()
      .filter((job) => job.workflowId === workflow.id && ["queued", "running", "retrying", "waiting_approval"].includes(job.status))
      .forEach((job) => {
        job.status = workflow.status === "completed" || workflow.status === "failed" ? workflow.status : "queued";
        saveJob(job);
      });

    return workflow;
  }

  function resumeApproval(approval) {
    const workflowId = approval?.proposedAction?.workflow_id;
    const stepId = approval?.proposedAction?.step_id;
    const workflow = workflowId ? getWorkflow(workflowId) : null;
    if (!workflow || approval.status !== "approved") return null;
    const step = workflow.steps.find((entry) => entry.id === stepId);
    if (!step || step.status !== "waiting_approval") return null;
    step.status = "completed";
    step.output = { approval_id: approval.id, decided_by: approval.decidedBy || "user" };
    workflow.context[step.id] = step.output;
    workflow.context.release_approval_id = approval.id;
    workflow.status = "running";
    workflow.timeline.push({ status: "approved", step: step.id, message: `Approval received: ${approval.id}`, createdAt: nowIso() });
    saveWorkflow(workflow);
    listJobs()
      .filter((job) => job.workflowId === workflow.id && ["waiting_approval", "queued", "running", "retrying"].includes(job.status))
      .forEach((job) => {
        job.status = "queued";
        saveJob(job);
      });
    return workflow;
  }

  function tickWorker() {
    const jobs = listJobs().filter((job) => ["queued", "running", "retrying"].includes(job.status));
    const job = jobs[0] || null;
    if (!job) {
      return { status: "idle", heartbeatAt: nowIso(), activeJob: null };
    }

    const workflow = getWorkflow(job.workflowId);
    if (!workflow) {
      job.status = "failed";
      job.error = "Workflow not found during recovery.";
      saveJob(job);
      return { status: "failed", activeJob: job };
    }

    job.status = "running";
    job.attempts += 1;
    saveJob(job);

    try {
      const states = stepStates(workflow);
      const nextStep = workflow.steps.find((step) => step.status === "pending" && dependenciesComplete(step, states));
      if (!nextStep) {
        if (workflow.steps.some((step) => step.status === "waiting_approval")) {
          workflow.status = "waiting_approval";
          job.status = "waiting_approval";
        } else if (workflow.steps.every((step) => step.status === "completed")) {
          workflow.status = "completed";
          job.status = "completed";
          workflow.timeline.push({ status: "completed", message: "Workflow completed", createdAt: nowIso() });
        }
        saveWorkflow(workflow);
        saveJob(job);
        return { status: job.status, workflow, activeJob: job };
      }

      const maybePromise = executeStep(workflow, nextStep);
      if (maybePromise?.then) {
        throw new Error("Async workflow step requires tickWorkerAsync.");
      }
      if (workflow.status === "waiting_approval") {
        job.status = "waiting_approval";
      }
      if (workflow.status !== "waiting_approval" && workflow.steps.every((step) => step.status === "completed")) {
        workflow.status = "completed";
        job.status = "completed";
        workflow.timeline.push({ status: "completed", message: "Workflow completed", createdAt: nowIso() });
      }
      saveWorkflow(workflow);
      saveJob(job);
      return { status: workflow.status, workflow, activeJob: job };
    } catch (error) {
      const currentStep = workflow.steps.find((step) => step.status === "running");
      if (currentStep && currentStep.retryCount < workflow.retryLimit) {
        currentStep.retryCount += 1;
        currentStep.status = "pending";
        workflow.status = "retrying";
        job.status = "retrying";
        workflow.timeline.push({ status: "retrying", step: currentStep.id, message: error.message, createdAt: nowIso() });
      } else {
        workflow.status = "failed";
        job.status = "failed";
        job.error = error.message;
        workflow.timeline.push({ status: "failed", message: error.message, createdAt: nowIso() });
      }
      saveWorkflow(workflow);
      saveJob(job);
      return { status: job.status, workflow, activeJob: job };
    }
  }

  async function tickWorkerAsync() {
    if (activeTicks >= Math.max(1, Number(maxConcurrentWorkflows || 1))) {
      return { status: "busy", activeJob: null, heartbeatAt: nowIso() };
    }
    const jobs = listJobs().filter((job) => ["queued", "running", "retrying"].includes(job.status));
    const job = jobs[0] || null;
    if (!job) return { status: "idle", heartbeatAt: nowIso(), activeJob: null };
    const workflow = getWorkflow(job.workflowId);
    if (!workflow) {
      job.status = "failed";
      job.error = "Workflow not found during recovery.";
      saveJob(job);
      return { status: "failed", activeJob: job };
    }
    activeTicks += 1;
    job.status = "running";
    job.startedAt = job.startedAt || nowIso();
    job.attempts += 1;
    saveJob(job);
    try {
      if (Date.now() - Date.parse(job.startedAt) > workflowTimeoutMs) {
        return failWorkflow(workflow, job, `Workflow timed out after ${workflowTimeoutMs}ms`);
      }
      const states = stepStates(workflow);
      const nextStep = workflow.steps.find((step) => step.status === "pending" && dependenciesComplete(step, states));
      if (!nextStep) {
        if (workflow.steps.some((step) => step.status === "waiting_approval")) {
          workflow.status = "waiting_approval";
          job.status = "waiting_approval";
        } else if (workflow.steps.every((step) => step.status === "completed")) {
          workflow.status = "completed";
          job.status = "completed";
          workflow.timeline.push({ status: "completed", message: "Workflow completed", createdAt: nowIso() });
        }
        saveWorkflow(workflow);
        saveJob(job);
        return { status: job.status, workflow, activeJob: job };
      }
      workflow.timeline.push({ status: nextStep.target.includes("search") ? "researching" : nextStep.target.includes("content") ? "generating" : nextStep.target.includes("test") ? "testing" : nextStep.target.includes("deploy") ? "deploying" : "running", step: nextStep.id, message: `${nextStep.target} queued`, createdAt: nowIso() });
      await withTimeout(Promise.resolve(executeStep(workflow, nextStep)), workflowTimeoutMs);
      if (workflow.steps.some((step) => step.status === "failed")) {
        workflow.status = "failed";
        job.status = "failed";
        workflow.timeline.push({ status: "failed", step: nextStep.id, message: `${nextStep.target} failed`, createdAt: nowIso() });
      }
      if (workflow.status !== "waiting_approval" && workflow.steps.every((step) => step.status === "completed")) {
        workflow.status = "completed";
        job.status = "completed";
        workflow.timeline.push({ status: "completed", message: "Workflow completed", createdAt: nowIso() });
      }
      saveWorkflow(workflow);
      saveJob(job);
      return { status: workflow.status, workflow, activeJob: job };
    } catch (error) {
      const currentStep = workflow.steps.find((step) => step.status === "running");
      if (currentStep && currentStep.retryCount < workflow.retryLimit) {
        currentStep.retryCount += 1;
        currentStep.status = "pending";
        workflow.status = "retrying";
        job.status = "retrying";
        workflow.timeline.push({ status: "retrying", step: currentStep.id, message: error.message, createdAt: nowIso() });
      } else {
        workflow.status = "failed";
        job.status = "failed";
        job.error = error.message;
        workflow.timeline.push({ status: "failed", message: error.message, createdAt: nowIso() });
      }
      saveWorkflow(workflow);
      saveJob(job);
      return { status: job.status, workflow, activeJob: job };
    } finally {
      activeTicks = Math.max(0, activeTicks - 1);
    }
  }

  async function runBackgroundOnce() {
    const result = await tickWorkerAsync();
    return result;
  }

  function createBot(payload = {}) {
    const bot = {
      id: payload.id || createId("bot"),
      name: payload.name || "Untitled bot",
      goal: payload.goal || "",
      instructions: payload.instructions || "",
      tools: payload.tools || [],
      memoryEnabled: payload.memory_enabled !== false && payload.memoryEnabled !== false,
      schedules: payload.schedules || [],
      approvalPolicy: payload.approval_policy || payload.approvalPolicy || "human_required_for_risky_actions",
      status: "active",
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    saveSetting(repository, "bots", bot.id, bot);
    saveSetting(repository, "bot_memory", bot.id, {
      botId: bot.id,
      history: [],
      preferences: {},
      outputs: [],
      workflowContext: {},
      reusablePrompts: [],
      updatedAt: nowIso()
    });
    log("bot_created", { botId: bot.id, name: bot.name });
    return bot;
  }

  function listBots() {
    return settingList(repository, "bots");
  }

  function getBotMemory(botId) {
    return repository.getSetting?.("bot_memory", botId)?.value || null;
  }

  function saveBotMemory(botId, patch = {}) {
    const memory = getBotMemory(botId) || { botId, history: [], preferences: {}, outputs: [], workflowContext: {}, reusablePrompts: [] };
    const next = { ...memory, ...patch, updatedAt: nowIso() };
    return saveSetting(repository, "bot_memory", botId, next);
  }

  return {
    createBot,
    createWorkflow,
    getBotMemory,
    getWorkflow,
    integrations: () => integrations,
    listBots,
    listJobs,
    listWorkflows,
    saveBotMemory,
    startWorkflow,
    templates: () => workflowTemplates,
    tickWorker,
    tickWorkerAsync,
    runBackgroundOnce,
    resumeCodingTask,
    resumeApproval
  };
}

module.exports = {
  createWorkflowEngine,
  integrations,
  workflowTemplates
};
