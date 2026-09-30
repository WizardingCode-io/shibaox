import type { RunState, RunStatus } from '@wizardingcode/shibaox-core';
import type { Card } from './stream.js';

export const money = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** What the orchestrator is told when a run it dispatched ends (the event turn's request). */
export function eventTurnText(
  st: RunState,
  status: RunStatus,
  cards: readonly Card[] = [],
): string {
  const nodes = Object.entries(st.nodes);
  const summaries = nodes
    .filter(([, n]) => n.summary)
    .map(([id, n]) => `${id}: ${String(n.summary).replace(/\s+/g, ' ').slice(0, 200)}`);
  const files = cards.find((c) => c.kind === 'summary');
  // the answering task's output, in the requested shape, once the run completed
  const answer = st.input.output_schema && status === 'completed' ? st.answer : undefined;
  const parts = [
    `workflow ${st.workflow} finished: ${status}`,
    ...(answer !== undefined ? [`answer: ${JSON.stringify(answer).slice(0, 1500)}`] : []),
    `${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
    money(st.spentUsd),
    ...(files?.kind === 'summary' && files.files.length > 0
      ? [`files: ${files.files.slice(0, 20).join(', ')}`]
      : []),
    ...(st.branch ? [`branch ${st.branch}`] : []),
    ...(st.error ? [`error: ${st.error}`] : []),
    ...summaries,
  ];
  return parts.join(' · ').slice(0, 2000);
}
