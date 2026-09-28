import type { RunState, StoredEvent } from '@wizardingcode/shibaox-core';
import type { Workflow } from '@wizardingcode/shibaox-schemas';

export interface RunReport {
  runId: string;
  workflow: string;
  status: string;
  /** `schedule:<id>`, `telegram:<chatId>`; where the report is delivered. */
  origin?: string;
  project: string;
  spentUsd: number;
  durationMs?: number;
  nodes: { id: string; status: string; summary?: string }[];
  /** What the run waits for from a human (prompt of the pending human node or approval). */
  needs?: string;
  error?: string;
  branch?: string;
  /** The orchestrator's answer when the run is a conversation turn. */
  reply?: string;
  /** The vault run note, when one was written. */
  notePath?: string;
}

const SUMMARY_MAX = 200;

const oneLine = (s: string, max = SUMMARY_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
};

/** The text a task produced: `output.text`, else its summary. */
function replyOf(state: RunState, workflow: Workflow | undefined): string | undefined {
  const ids = workflow ? Object.keys(workflow.nodes) : Object.keys(state.nodes);
  for (const id of [...ids].reverse()) {
    const n = state.nodes[id];
    if (n?.status !== 'completed') continue;
    if (workflow && workflow.nodes[id]?.type !== 'task') continue;
    const out = n.output as { text?: unknown } | undefined;
    if (out && typeof out.text === 'string' && out.text.trim()) return out.text.trim();
    if (n.summary?.trim()) return n.summary.trim();
  }
  return undefined;
}

/** What a run's end (or wait) looks like to whoever asked for it; never file contents. */
export function buildRunReport(
  state: RunState,
  events: StoredEvent[],
  workflow: Workflow | undefined,
  o: { notePath?: string } = {},
): RunReport {
  // from the request (queue time counts for whoever waits for the answer) to the last event
  const startedAt = events[0]?.at;
  const endedAt = events.at(-1)?.at;
  const durationMs =
    startedAt && endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
  const order = workflow ? Object.keys(workflow.nodes) : Object.keys(state.nodes);
  const nodes = order
    .filter((id) => state.nodes[id])
    .map((id) => {
      const n = state.nodes[id] as NonNullable<RunState['nodes'][string]>;
      const text = n.summary ?? n.error;
      return { id, status: n.status, ...(text ? { summary: oneLine(text) } : {}) };
    });
  const pendingHuman = state.pendingHumans[0]?.prompt;
  const pendingApproval = state.pendingApprovals[0]?.command;
  const needs = pendingHuman ?? (pendingApproval ? `approve: ${pendingApproval}` : undefined);
  const conversation = workflow?.conversation === true;
  return {
    runId: state.runId,
    workflow: state.workflow,
    status: state.status,
    origin: state.origin,
    project: state.project ?? state.workspace,
    spentUsd: state.spentUsd,
    durationMs,
    nodes,
    ...(needs ? { needs } : {}),
    ...(state.error ? { error: oneLine(state.error, 500) } : {}),
    ...(state.branch ? { branch: state.branch } : {}),
    ...(conversation ? { reply: replyOf(state, workflow) } : {}),
    ...(o.notePath ? { notePath: o.notePath } : {}),
  };
}

/**
 * Splits `text` into pieces whose `measure` (default: length) stays within `limit`, at line
 * breaks when it can; a single line longer than the limit is cut by characters. With a
 * measure that counts the HTML-escaped size, no entity is ever split.
 */
export function chunkBy(
  text: string,
  limit: number,
  measure: (s: string) => number = (s) => s.length,
): string[] {
  const out: string[] = [];
  let piece = '';
  const flush = () => {
    if (piece.length > 0) out.push(piece);
    piece = '';
  };
  for (const line of text.split('\n')) {
    const candidate = piece ? `${piece}\n${line}` : line;
    if (measure(candidate) <= limit) {
      piece = candidate;
      continue;
    }
    flush();
    if (measure(line) <= limit) {
      piece = line;
      continue;
    }
    // one line over the limit: cut it by characters (code points, never inside a surrogate pair)
    let current = '';
    for (const ch of line) {
      if (measure(current + ch) > limit) {
        out.push(current);
        current = ch;
      } else current += ch;
    }
    piece = current;
  }
  flush();
  return out.filter((p) => p.length > 0);
}

/** Splits `text` into pieces of at most `limit` chars, at line breaks when it can. */
export function chunkText(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out.filter((piece) => piece.length > 0);
}

export const STATUS_SYMBOL: Record<string, string> = {
  completed: '✓',
  failed: '✗',
  cancelled: '—',
  waiting_human: '▲',
  waiting_approval: '▲',
  paused_budget: '‖',
};

/** `45 s`, `8m 42s`, `2h 05m`. */
export function shortDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
