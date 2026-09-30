import { transitionsOf, type Workflow } from '@wizardingcode/shibaox-schemas';

const cache = new WeakMap<Workflow, string[]>();

/**
 * The tasks that answer a run: those from which no other task is reachable (a human, git or
 * gate node after them is fine; a gate looping back to the task itself is fine too).
 */
export function finalTaskIds(workflow: Workflow): string[] {
  const hit = cache.get(workflow);
  if (hit) return hit;
  const next = new Map<string, string[]>();
  for (const [id, node] of Object.entries(workflow.nodes)) next.set(id, [...transitionsOf(node)]);
  // a parallel branch without its own `next` continues at the join
  for (const node of Object.values(workflow.nodes))
    if (node.type === 'parallel')
      for (const b of node.branches) {
        const edges = next.get(b) ?? [];
        if (!edges.length) next.set(b, [node.join]);
      }
  const out: string[] = [];
  for (const [id, node] of Object.entries(workflow.nodes)) {
    if (node.type !== 'task') continue;
    const seen = new Set<string>();
    const stack = [...(next.get(id) ?? [])];
    let other = false;
    while (stack.length && !other) {
      const cur = stack.pop() as string;
      if (cur === id || seen.has(cur)) continue;
      seen.add(cur);
      if (workflow.nodes[cur]?.type === 'task') other = true;
      else stack.push(...(next.get(cur) ?? []));
    }
    if (!other) out.push(id);
  }
  cache.set(workflow, out);
  return out;
}
