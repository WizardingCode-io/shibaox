import { type Team, transitionsOf, type Workflow, type WorkflowNode } from '@shibaox/schemas';

function redirect(node: WorkflowNode, from: string, to: string): WorkflowNode {
  switch (node.type) {
    case 'task':
    case 'code':
    case 'human':
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
  if (team.gates.length === 0) return workflow;
  const covered = Object.values(workflow.nodes).some(
    (n) => n.type === 'gate' && team.gates.every((g) => n.gates.includes(g)),
  );
  if (covered) return workflow;

  const nodes: Record<string, WorkflowNode> = { ...workflow.nodes };
  const terminals = Object.entries(workflow.nodes)
    .filter(([, n]) => transitionsOf(n).length === 0)
    .map(([id]) => id);
  for (const t of terminals) {
    const gateId = `team-gate:${t}`;
    let inserted = false;
    for (const [pid, pnode] of Object.entries(workflow.nodes)) {
      if (pnode.type === 'gate' || !transitionsOf(pnode).includes(t)) continue;
      nodes[pid] = redirect(nodes[pid] ?? pnode, t, gateId);
      if (!inserted) {
        nodes[gateId] = {
          type: 'gate',
          gates: [...team.gates],
          on_pass: t,
          on_fail: pid,
          max_retries: 3,
        };
        inserted = true;
      }
    }
  }
  return { ...workflow, nodes };
}
