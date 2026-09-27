import type { RunEvent } from '@shibaox/schemas';
import type { NodeState, PendingApproval, RunState, RunStatus } from './state.js';

function nodeOf(state: RunState, id: string): NodeState {
  return state.nodes[id] ?? { status: 'pending', attempts: 0, approvals: {} };
}

function withNode(state: RunState, id: string, patch: Partial<NodeState>): RunState {
  return { ...state, nodes: { ...state.nodes, [id]: { ...nodeOf(state, id), ...patch } } };
}

function addCost(state: RunState, event: RunEvent): RunState {
  const cost = 'cost' in event ? event.cost : undefined;
  return cost ? { ...state, spentUsd: state.spentUsd + cost.usd } : state;
}

export function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

type NonCreatedEvent = Exclude<RunEvent, { type: 'RunCreated' }>;

function applyEvent(s: RunState, event: NonCreatedEvent, idx: number): RunState {
  switch (event.type) {
    case 'RunStarted':
      return s.status === 'queued' ? { ...s, status: 'running' } : s;
    case 'NodeStarted': {
      const started = withNode(s, event.nodeId, {
        status: 'running',
        startedIdx: idx,
        attempts: nodeOf(s, event.nodeId).attempts + 1,
        error: undefined,
      });
      // logs recorded before RunStarted existed start with the first node
      return started.status === 'queued' ? { ...started, status: 'running' } : started;
    }
    case 'SessionStarted':
      return withNode(s, event.nodeId, { sessionId: event.sessionId });
    case 'ToolApprovalRequested': {
      const n = nodeOf(s, event.nodeId);
      const pending: PendingApproval = {
        approvalId: event.approvalId,
        runId: event.runId,
        nodeId: event.nodeId,
        role: event.role,
        tool: event.tool,
        program: event.program,
        category: event.category,
        command: event.command,
        argvHash: event.argvHash,
        at: event.at,
      };
      return {
        ...withNode(s, event.nodeId, {
          approvals: {
            ...n.approvals,
            [event.approvalId]: { argvHash: event.argvHash, command: event.command },
          },
        }),
        status: s.status === 'running' ? 'waiting_approval' : s.status,
        pendingApprovals: [
          ...s.pendingApprovals.filter((p) => p.approvalId !== event.approvalId),
          pending,
        ],
      };
    }
    case 'ToolApprovalResolved': {
      const n = nodeOf(s, event.nodeId);
      const prev = n.approvals[event.approvalId];
      const pendingApprovals = s.pendingApprovals.filter((p) => p.approvalId !== event.approvalId);
      const next = withNode(s, event.nodeId, {
        approvals: {
          ...n.approvals,
          [event.approvalId]: {
            argvHash: prev?.argvHash ?? '',
            command: prev?.command ?? '',
            approved: event.approved,
            note: event.note,
          },
        },
      });
      const status: RunStatus =
        s.status !== 'waiting_approval'
          ? s.status
          : pendingApprovals.length > 0
            ? 'waiting_approval'
            : s.pendingHumans.length > 0
              ? 'waiting_human'
              : 'running';
      return { ...next, pendingApprovals, status };
    }
    case 'NodeSuspended': {
      // the suspended task becomes never-started again, keeping its session for resume
      const { startedIdx: _startedIdx, ...rest } = nodeOf(s, event.nodeId);
      return {
        ...s,
        nodes: {
          ...s.nodes,
          [event.nodeId]: {
            ...rest,
            status: 'pending',
            sessionId: event.sessionId ?? rest.sessionId,
          },
        },
      };
    }
    case 'NodeCompleted':
      // a finished attempt closes its session: a rework starts fresh with the gate report
      return withNode(s, event.nodeId, {
        status: 'completed',
        finishedIdx: idx,
        output: event.output,
        summary: event.summary,
        sessionId: undefined,
      });
    case 'NodeFailed':
      return {
        ...withNode(s, event.nodeId, {
          status: 'failed',
          finishedIdx: idx,
          error: event.error,
          sessionId: undefined,
        }),
        status: 'failed',
        error: `${event.nodeId}: ${event.error}`,
      };
    case 'GatePassed':
      return {
        ...withNode(s, event.nodeId, { status: 'passed', finishedIdx: idx, report: event.report }),
        lastGateReport: event.report,
      };
    case 'GateFailed':
      // The rework target is informational: the scheduler re-readies it by
      // event order (this gate finished after the rework node last started).
      return {
        ...withNode(s, event.nodeId, {
          status: 'gate_failed',
          finishedIdx: idx,
          report: event.report,
        }),
        lastGateReport: event.report,
      };
    case 'DecisionMade':
      return withNode(s, event.nodeId, {
        status: 'completed',
        finishedIdx: idx,
        choice: event.choice,
        output: { choice: event.choice, confidence: event.confidence },
      });
    case 'HumanRequested':
      return {
        ...withNode(s, event.nodeId, { status: 'waiting' }),
        status: s.status === 'waiting_approval' ? s.status : 'waiting_human',
        pendingHumans: [
          ...s.pendingHumans.filter((p) => p.nodeId !== event.nodeId),
          { nodeId: event.nodeId, action: event.action, prompt: event.prompt },
        ],
      };
    case 'HumanResponded': {
      const pendingHumans = s.pendingHumans.filter((p) => p.nodeId !== event.nodeId);
      const answered = withNode(s, event.nodeId, {
        status: 'completed',
        finishedIdx: idx,
        output: { approved: event.approved, note: event.note },
      });
      if (!event.approved)
        return {
          ...answered,
          pendingHumans: [],
          status: 'cancelled',
          error: `rejected by human at ${event.nodeId}${event.note ? `: ${event.note}` : ''}`,
        };
      return {
        ...answered,
        pendingHumans,
        status:
          pendingHumans.length > 0
            ? 'waiting_human'
            : s.pendingApprovals.length > 0
              ? 'waiting_approval'
              : 'running',
      };
    }
    case 'BudgetWarning':
      return { ...s, budgetWarned: true };
    case 'BudgetExceeded': {
      if (event.nodeId === undefined) return { ...s, status: 'paused_budget' };
      // the stopped task becomes never-started again, so it re-runs once the run resumes;
      // a fresh session (no resume): only approval suspensions keep the session id
      const { startedIdx: _startedIdx, sessionId: _sessionId, ...rest } = nodeOf(s, event.nodeId);
      return {
        ...s,
        status: 'paused_budget',
        nodes: { ...s.nodes, [event.nodeId]: { ...rest, status: 'pending' } },
      };
    }
    case 'RunResumed':
      return {
        ...s,
        status: s.status === 'paused_budget' ? 'running' : s.status,
        budgetUsd: event.budgetUsd ?? s.budgetUsd,
        budgetWarned: false,
      };
    case 'RunCompleted':
      return { ...s, status: 'completed' };
    case 'RunCancelled':
      return { ...s, status: 'cancelled', error: event.reason };
  }
}

/**
 * Applies one event. `idx` is the event's 0-based position in the run's log;
 * it is recorded as `startedIdx`/`finishedIdx` so the scheduler can decide
 * readiness by event order.
 */
export function reduce(state: RunState | undefined, event: RunEvent, idx: number): RunState {
  if (event.type === 'RunCreated') {
    return {
      runId: event.runId,
      workflow: event.workflow,
      workflowSnapshot: event.workflowSnapshot,
      input: event.input,
      workspace: event.workspace,
      adapter: event.adapter,
      workspaceMode: event.workspaceMode,
      project: event.project,
      branch: event.branch,
      orgRoot: event.orgRoot,
      parentRunId: event.parentRunId,
      origin: event.origin,
      status: 'queued',
      nodes: {},
      spentUsd: 0,
      budgetUsd: event.budgetUsd,
      budgetWarned: false,
      pendingHumans: [],
      pendingApprovals: [],
    };
  }
  if (!state) throw new Error(`event ${event.type} before RunCreated for run ${event.runId}`);
  const s = addCost(state, event);
  const next = applyEvent(s, event, idx);
  // Once a run reaches a terminal status, later events (e.g. a sibling's
  // HumanRequested/HumanResponded racing a parallel branch's NodeFailed) must
  // still update node entries, spentUsd and reports, but must never resurrect
  // the run-level status or overwrite the error that terminated it.
  if (isTerminal(state.status))
    return {
      ...next,
      status: state.status,
      error: state.error,
      pendingHumans: [],
      pendingApprovals: [],
    };
  return isTerminal(next.status) ? { ...next, pendingHumans: [], pendingApprovals: [] } : next;
}

export function replay(events: readonly RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const [idx, e] of events.entries()) state = reduce(state, e, idx);
  if (!state) throw new Error('cannot replay an empty event list');
  return state;
}
