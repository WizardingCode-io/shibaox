import {
  type Team,
  transitionsOf,
  type Workflow,
  type WorkflowNode,
} from '@wizardingcode/shibaox-schemas';

function redirect(node: WorkflowNode, from: string, to: string): WorkflowNode {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
    case 'git':
      return node.next === from ? { ...node, next: to } : node;
    case 'decide':
      return {
        ...node,
        next: Object.fromEntries(
          Object.entries(node.next).map(([k, v]) => [k, v === from ? to : v]),
        ),
      };
    case 'parallel':
      return {
        ...node,
        branches: node.branches.map((b) => (b === from ? to : b)),
        join: node.join === from ? to : node.join,
      };
    case 'gate':
      return node;
  }
}

export function injectTeamGates(workflow: Workflow, team: Team): Workflow {
  if (team.gates.length === 0 || workflow.team_gates === false) return workflow;
  const covered = Object.values(workflow.nodes).some(
    (n) => n.type === 'gate' && team.gates.every((g) => n.gates.includes(g)),
  );
  if (covered) return workflow;

  const nodes: Record<string, WorkflowNode> = { ...workflow.nodes };
  const terminals = Object.entries(workflow.nodes)
    .filter(([, n]) => transitionsOf(n).length === 0)
    .map(([id]) => id);
  for (const t of terminals) {
    for (const [pid, pnode] of Object.entries(workflow.nodes)) {
      if (pnode.type === 'gate' || !transitionsOf(pnode).includes(t)) continue;
      const gateId = `team-gate:${pid}:${t}`;
      nodes[pid] = redirect(nodes[pid] ?? pnode, t, gateId);
      nodes[gateId] = {
        type: 'gate',
        gates: [...team.gates],
        on_pass: t,
        on_fail: pid,
        max_retries: 3,
      };
    }
  }
  return { ...workflow, nodes };
}
