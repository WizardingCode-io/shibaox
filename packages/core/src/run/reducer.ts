import type { RunEvent } from '@shibaox/schemas';
import type { NodeState, RunState, RunStatus } from './state.js';

function nodeOf(state: RunState, id: string): NodeState {
  return state.nodes[id] ?? { status: 'pending', attempts: 0 };
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
    case 'NodeStarted':
      return withNode(s, event.nodeId, {
        status: 'running',
        startedIdx: idx,
        attempts: nodeOf(s, event.nodeId).attempts + 1,
        error: undefined,
      });
    case 'NodeCompleted':
      return withNode(s, event.nodeId, {
        status: 'completed',
        finishedIdx: idx,
        output: event.output,
        summary: event.summary,
      });
    case 'NodeFailed':
      return {
        ...withNode(s, event.nodeId, { status: 'failed', finishedIdx: idx, error: event.error }),
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
        status: 'waiting_human',
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
        status: pendingHumans.length > 0 ? 'waiting_human' : 'running',
      };
    }
    case 'BudgetWarning':
      return { ...s, budgetWarned: true };
    case 'BudgetExceeded':
      return { ...s, status: 'paused_budget' };
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
      status: 'running',
      nodes: {},
      spentUsd: 0,
      budgetUsd: event.budgetUsd,
      budgetWarned: false,
      pendingHumans: [],
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
    return { ...next, status: state.status, error: state.error, pendingHumans: [] };
  return isTerminal(next.status) ? { ...next, pendingHumans: [] } : next;
}

export function replay(events: readonly RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const [idx, e] of events.entries()) state = reduce(state, e, idx);
  if (!state) throw new Error('cannot replay an empty event list');
  return state;
}
