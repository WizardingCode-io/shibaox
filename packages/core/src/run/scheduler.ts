import { transitionsOf, type Workflow } from '@shibaox/schemas';
import type { NodeState, NodeStatus, RunState } from './state.js';

const finished = (s: NodeStatus | undefined) => s === 'completed' || s === 'passed';

/**
 * A node that has never started: no entry at all, or an entry left `pending`
 * without a `startedIdx` (a node that was running when the process crashed,
 * see `markInterrupted` in the engine).
 */
const neverStarted = (n: NodeState | undefined) =>
  n === undefined || (n.status === 'pending' && n.startedIdx === undefined);

/**
 * Order-based readiness. A node P with an outcome points at its targets; a
 * target X is ready when it never started, or when it is not in flight and P
 * finished after X last started (so each outcome triggers X at most once).
 */
export function readyNodes(state: RunState, workflow: Workflow): string[] {
  if (state.status !== 'running') return [];
  const ready = new Set<string>();
  if (neverStarted(state.nodes[workflow.start])) ready.add(workflow.start);

  const readyAfter = (target: string, finishedIdx: number | undefined): boolean => {
    const x = state.nodes[target];
    if (neverStarted(x)) return true;
    if (!x || x.status === 'running' || x.status === 'waiting') return false;
    return finishedIdx !== undefined && x.startedIdx !== undefined && finishedIdx > x.startedIdx;
  };

  for (const [id, node] of Object.entries(workflow.nodes)) {
    const p = state.nodes[id];
    if (!p) continue;
    const targets: string[] = [];
    switch (node.type) {
      case 'task':
      case 'code':
      case 'human':
        if (p.status === 'completed' && node.next) targets.push(node.next);
        break;
      case 'decide': {
        const target = p.choice ? node.next[p.choice] : undefined;
        if (p.status === 'completed' && target) targets.push(target);
        break;
      }
      case 'gate':
        if (p.status === 'passed') targets.push(node.on_pass);
        else if (p.status === 'gate_failed') targets.push(node.on_fail);
        break;
      case 'parallel':
        if (p.status === 'completed') {
          targets.push(...node.branches);
          if (joinReady(state, p.finishedIdx, node.branches, node.join)) ready.add(node.join);
        }
        break;
    }
    for (const t of targets) if (readyAfter(t, p.finishedIdx)) ready.add(t);
  }
  return [...ready].sort();
}

/**
 * Detects a run that is `running` with no ready node and no way to ever get
 * one: a node left `pending` after having started (interrupted/reworked) or
 * `gate_failed`, whose predecessors have not finished again since it started.
 * Distinguishes a genuinely stuck run from one that has simply reached its
 * end (nothing left `pending`/`gate_failed`), which should complete instead.
 */
export function isStalled(
  state: RunState,
  workflow: Workflow,
): { stalled: boolean; reason?: string } {
  if (state.status !== 'running') return { stalled: false };
  for (const [id, n] of Object.entries(state.nodes)) {
    const suspect =
      (n.status === 'pending' && n.startedIdx !== undefined) || n.status === 'gate_failed';
    if (!suspect) continue;
    const hasLivePredecessor = Object.entries(workflow.nodes).some(([predId, predNode]) => {
      if (!transitionsOf(predNode).includes(id)) return false;
      const pred = state.nodes[predId];
      return (
        pred?.finishedIdx !== undefined &&
        n.startedIdx !== undefined &&
        pred.finishedIdx > n.startedIdx
      );
    });
    if (!hasLivePredecessor) {
      return {
        stalled: true,
        reason: `node "${id}" is pending but no predecessor finished after it started`,
      };
    }
  }
  return { stalled: false };
}

/**
 * A join is ready when every branch finished after the current fan-out
 * (`branch.finishedIdx > parallel.finishedIdx`) and, if the join already ran,
 * some branch finished after it last started. "Some" lets a gate that reworks
 * a single branch re-run as the join without re-running the other branches.
 */
function joinReady(
  state: RunState,
  parallelFinishedIdx: number | undefined,
  branches: readonly string[],
  joinId: string,
): boolean {
  const join = state.nodes[joinId];
  if (join && (join.status === 'running' || join.status === 'waiting')) return false;
  if (parallelFinishedIdx === undefined) return false;
  const branchStates = branches.map((b) => state.nodes[b]);
  const fresh = branchStates.every(
    (b) =>
      b !== undefined &&
      finished(b.status) &&
      b.finishedIdx !== undefined &&
      b.finishedIdx > parallelFinishedIdx,
  );
  if (!fresh) return false;
  if (neverStarted(join)) return true;
  const joinStarted = join?.startedIdx;
  return (
    joinStarted !== undefined &&
    branchStates.some((b) => b?.finishedIdx !== undefined && b.finishedIdx > joinStarted)
  );
}
