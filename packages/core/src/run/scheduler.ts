import type { Workflow } from '@shibaox/schemas';
import type { NodeStatus, RunState } from './state.js';

const finished = (s: NodeStatus) => s === 'completed' || s === 'passed';

export function readyNodes(state: RunState, workflow: Workflow): string[] {
  if (state.status !== 'running') return [];
  const statusOf = (id: string): NodeStatus => state.nodes[id]?.status ?? 'pending';
  const ready = new Set<string>();
  if (Object.keys(state.nodes).length === 0 && statusOf(workflow.start) === 'pending') {
    ready.add(workflow.start);
  }

  for (const [id, node] of Object.entries(workflow.nodes)) {
    const status = statusOf(id);
    const targets: string[] = [];
    switch (node.type) {
      case 'task':
      case 'code':
      case 'human':
        if (status === 'completed' && node.next) targets.push(node.next);
        break;
      case 'decide': {
        const choice = state.nodes[id]?.choice;
        if (status === 'completed' && choice && node.next[choice]) targets.push(node.next[choice]);
        break;
      }
      case 'gate':
        if (status === 'passed') targets.push(node.on_pass);
        break;
      case 'parallel':
        if (status === 'completed') {
          targets.push(...node.branches);
          if (node.branches.every((b) => finished(statusOf(b)))) targets.push(node.join);
        }
        break;
    }
    for (const t of targets) if (statusOf(t) === 'pending') ready.add(t);
  }
  return [...ready].sort();
}
