const seedApprovals = [
  {
    id: "approval_demo_live_trade",
    title: "Live trade approval gate",
    status: "pending",
    approvalType: "trading_execution",
    riskLevel: "critical",
    requestedBy: "trading-agent",
    description: "Demo approval showing that live trading must be approved by a human.",
    proposedAction: {
      tool: "trading.execute",
      summary: "Demo live trade approval gate"
    },
    createdAt: new Date().toISOString()
  }
];

function nowIso() {
  return new Date().toISOString();
}

function createMemoryApprovalQueue() {
  const approvals = [...seedApprovals];
  const actionLog = [];

  function logAction(action, payload = {}) {
    const entry = {
      id: `log_${Date.now()}_${actionLog.length + 1}`,
      action,
      payload,
      createdAt: nowIso()
    };
    actionLog.unshift(entry);
    return entry;
  }

  const queue = {
    list(filter = {}) {
      if (!filter.status) {
        return approvals;
      }
      return approvals.filter((approval) => approval.status === filter.status);
    },
    logs() {
      return actionLog;
    },
    get(id) {
      return approvals.find((approval) => approval.id === id) || null;
    },
    isApproved(id) {
      const approval = this.get(id);
      return approval?.status === "approved";
    },
    decide(id, status, decidedBy = "user") {
      const approval = this.get(id);
      if (!approval) {
        return null;
      }
      approval.status = status;
      approval.decidedBy = decidedBy;
      approval.decidedAt = nowIso();
      logAction(`approval.${status}`, {
        approvalId: approval.id,
        approvalType: approval.approvalType,
        riskLevel: approval.riskLevel,
        decidedBy
      });
      return approval;
    },
    add(approval) {
      const storedApproval = {
        ...approval,
        id: approval.id || `approval_${Date.now()}`,
        status: approval.status || "pending",
        approvalType: approval.approvalType || "risky_action",
        riskLevel: approval.riskLevel || "medium",
        requestedBy: approval.requestedBy || "system",
        proposedAction: approval.proposedAction || {},
        createdAt: approval.createdAt || nowIso()
      };
      approvals.unshift(storedApproval);
      logAction("approval.created", {
        approvalId: storedApproval.id,
        approvalType: storedApproval.approvalType,
        riskLevel: storedApproval.riskLevel,
        requestedBy: storedApproval.requestedBy,
        proposedAction: storedApproval.proposedAction
      });
      return storedApproval;
    },
    logAction
  };

  for (const approval of approvals) {
    logAction("approval.seeded", {
      approvalId: approval.id,
      approvalType: approval.approvalType,
      riskLevel: approval.riskLevel
    });
  }

  return queue;
}

function createApprovalQueue(repository) {
  if (!repository) {
    return createMemoryApprovalQueue();
  }

  if (!repository.getApproval(seedApprovals[0].id)) {
    repository.addApproval(seedApprovals[0]);
    repository.logAction("approval.seeded", {
      approvalId: seedApprovals[0].id,
      approvalType: seedApprovals[0].approvalType,
      riskLevel: seedApprovals[0].riskLevel
    });
  }

  return {
    list(filter = {}) {
      return repository.listApprovals(filter);
    },
    logs() {
      return repository.listLogs();
    },
    get(id) {
      return repository.getApproval(id);
    },
    isApproved(id) {
      return repository.getApproval(id)?.status === "approved";
    },
    decide(id, status, decidedBy = "user") {
      const approval = repository.decideApproval(id, status, decidedBy);
      if (approval) {
        repository.logAction(`approval.${status}`, {
          approvalId: approval.id,
          approvalType: approval.approvalType,
          riskLevel: approval.riskLevel,
          decidedBy
        });
      }
      return approval;
    },
    add(approval) {
      const storedApproval = repository.addApproval(approval);
      repository.logAction("approval.created", {
        approvalId: storedApproval.id,
        approvalType: storedApproval.approvalType,
        riskLevel: storedApproval.riskLevel,
        requestedBy: storedApproval.requestedBy,
        proposedAction: storedApproval.proposedAction
      });
      return storedApproval;
    },
    logAction(action, payload = {}) {
      return repository.logAction(action, payload);
    }
  };
}

const approvalQueue = createMemoryApprovalQueue();

module.exports = {
  approvalQueue,
  createApprovalQueue
};
