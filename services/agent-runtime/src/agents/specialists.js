function buildSpecialistResponse(agent, task, command) {
  const base = {
    agentId: agent.id,
    agentType: agent.type,
    taskId: task.id
  };

  switch (agent.type) {
    case "coding":
      return {
        ...base,
        message: `Coding Agent accepted task ${task.id}. It will inspect the codebase before proposing changes for: ${command}`
      };
    case "testing":
      return {
        ...base,
        message: `Testing Agent accepted task ${task.id}. It will validate behavior and report failures for: ${command}`
      };
    case "content":
      return {
        ...base,
        message: `Content Agent accepted task ${task.id}. It will draft or refine content for: ${command}`
      };
    case "trading":
      return {
        ...base,
        message: `Trading Agent accepted task ${task.id}. It will analyze the request and avoid live execution without approval.`
      };
    default:
      return {
        ...base,
        message: `Chat Agent accepted task ${task.id}. It will respond conversationally to: ${command}`
      };
  }
}

module.exports = { buildSpecialistResponse };

