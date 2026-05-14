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
  { id: "github", name: "GitHub", status: "placeholder", approvalRequired: true, description: "Repository context and issue/PR placeholders." },
  { id: "youtube", name: "YouTube", status: "placeholder", approvalRequired: true, description: "Content planning only. Publishing requires approval." },
  { id: "google-drive", name: "Google Drive", status: "placeholder", approvalRequired: true, description: "File planning placeholder." },
  { id: "web-search", name: "Web Search", status: "placeholder", approvalRequired: false, description: "Research placeholder for online workflows." }
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

function createWorkflowEngine({ repository, approvalQueue, appendTaskHistory, createTask }) {
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

  function stepStates(workflow) {
    return Object.fromEntries(workflow.steps.map((step) => [step.id, step]));
  }

  function executeStep(workflow, step) {
    step.status = "running";
    workflow.status = "running";
    workflow.timeline.push({ status: "executing", step: step.id, message: `${step.target} started`, createdAt: nowIso() });

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

    const output = {
      target: step.target,
      type: step.type,
      message: `${step.target} completed by workflow engine.`,
      input: step.input || {}
    };
    step.status = "completed";
    step.output = output;
    workflow.context[step.id] = output;
    workflow.timeline.push({ status: "completed", step: step.id, message: `${step.target} completed`, createdAt: nowIso() });

    if (step.type === "agent" && step.target === "coding-agent" && typeof createTask === "function") {
      const task = createTask({
        title: `${workflow.name}: coding task`,
        description: workflow.goal,
        assignedAgentId: "coding-agent",
        intent: "coding",
        metadata: { workflow_id: workflow.id, workflow_step_id: step.id }
      });
      appendTaskHistory?.(task.id, "workflow.task_created", { workflow_id: workflow.id, step_id: step.id });
      step.output.task_id = task.id;
    }
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

      executeStep(workflow, nextStep);
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
    tickWorker
  };
}

module.exports = {
  createWorkflowEngine,
  integrations,
  workflowTemplates
};
