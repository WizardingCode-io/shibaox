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

function isTerminal(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

type NonCreatedEvent = Exclude<RunEvent, { type: 'RunCreated' }>;

function applyEvent(s: RunState, event: NonCreatedEvent): RunState {
  switch (event.type) {
    case 'NodeStarted':
      return withNode(s, event.nodeId, {
        status: 'running',
        attempts: nodeOf(s, event.nodeId).attempts + 1,
        error: undefined,
      });
    case 'NodeCompleted':
      return withNode(s, event.nodeId, {
        status: 'completed',
        output: event.output,
        summary: event.summary,
      });
    case 'NodeFailed':
      return {
        ...withNode(s, event.nodeId, { status: 'failed', error: event.error }),
        status: 'failed',
        error: `${event.nodeId}: ${event.error}`,
      };
    case 'GatePassed':
      return {
        ...withNode(s, event.nodeId, { status: 'passed', report: event.report }),
        lastGateReport: event.report,
      };
    case 'GateFailed': {
      const afterGate = withNode(s, event.nodeId, { status: 'pending', report: event.report });
      const afterRework = withNode(afterGate, event.rework, { status: 'pending' });
      return { ...afterRework, lastGateReport: event.report };
    }
    case 'DecisionMade':
      return withNode(s, event.nodeId, {
        status: 'completed',
        choice: event.choice,
        output: { choice: event.choice, confidence: event.confidence },
      });
    case 'HumanRequested':
      return {
        ...withNode(s, event.nodeId, { status: 'waiting' }),
        status: 'waiting_human',
        pendingHuman: { nodeId: event.nodeId, action: event.action, prompt: event.prompt },
      };
    case 'HumanResponded':
      return {
        ...withNode(s, event.nodeId, {
          status: 'completed',
          output: { approved: event.approved, note: event.note },
        }),
        status: 'running',
        pendingHuman: undefined,
      };
    case 'BudgetWarning':
      return { ...s, budgetWarned: true };
    case 'BudgetExceeded':
      return { ...s, status: 'paused_budget' };
    case 'RunResumed':
      return {
        ...s,
        status: 'running',
        budgetUsd: event.budgetUsd ?? s.budgetUsd,
        budgetWarned: false,
      };
    case 'RunCompleted':
      return { ...s, status: 'completed' };
    case 'RunCancelled':
      return { ...s, status: 'cancelled', error: event.reason };
  }
}

export function reduce(state: RunState | undefined, event: RunEvent): RunState {
  if (event.type === 'RunCreated') {
    return {
      runId: event.runId,
      workflow: event.workflow,
      input: event.input,
      workspace: event.workspace,
      status: 'running',
      nodes: {},
      spentUsd: 0,
      budgetUsd: event.budgetUsd,
      budgetWarned: false,
    };
  }
  if (!state) throw new Error(`event ${event.type} before RunCreated for run ${event.runId}`);
  const s = addCost(state, event);
  const next = applyEvent(s, event);
  // Once a run reaches a terminal status, later events (e.g. a sibling's
  // HumanRequested/HumanResponded racing a parallel branch's NodeFailed) must
  // still update node entries, spentUsd and reports, but must never resurrect
  // the run-level status or overwrite the error that terminated it.
  return isTerminal(state.status)
    ? { ...next, status: state.status, error: state.error, pendingHuman: undefined }
    : next;
}

export function replay(events: readonly RunEvent[]): RunState {
  let state: RunState | undefined;
  for (const e of events) state = reduce(state, e);
  if (!state) throw new Error('cannot replay an empty event list');
  return state;
}
