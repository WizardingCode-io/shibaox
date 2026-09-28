import type { RunState } from '@wizardingcode/shibaox-core';

/** Text lines for people, or one JSON object per line for scripts (`--json`). */
export interface Out {
  readonly json: boolean;
  line(text: string): void;
  obj(o: unknown): void;
}

export function makeOut(json: boolean, write: (s: string) => void = (s) => console.log(s)): Out {
  return {
    json,
    line: (text) => {
      if (!json) write(text);
    },
    obj: (o) => {
      if (json) write(JSON.stringify(o));
    },
  };
}

export function formatState(state: RunState): string[] {
  const lines = [
    `run ${state.runId}  workflow=${state.workflow}  status=${state.status}  spent=$${state.spentUsd.toFixed(4)}`,
  ];
  for (const [id, n] of Object.entries(state.nodes))
    lines.push(
      `  ${id.padEnd(22)} ${n.status.padEnd(11)} attempts=${n.attempts}${n.choice ? ` choice=${n.choice}` : ''}${n.error ? ` error=${n.error}` : ''}`,
    );
  if (state.error) lines.push(`  error: ${state.error}`);
  for (const p of state.pendingHumans)
    lines.push(
      `  waiting for you at ${p.nodeId}: ${p.prompt} (shibaox approve human:${state.runId}:${p.nodeId})`,
    );
  for (const p of state.pendingApprovals)
    lines.push(
      `  waiting for approval at ${p.nodeId}: ${p.command} (shibaox approve approval:${p.approvalId})`,
    );
  return lines;
}

/** Exit code for a finished run: 0 completed, 2 anything else. */
export const exitCodeFor = (status: string): number => (status === 'completed' ? 0 : 2);
