import type { Envelope } from '@shibaox/daemon';

export interface ToolInfo {
  id?: string;
  name: string;
  summary: string;
  status: 'running' | 'done' | 'error' | 'approval';
  durationMs?: number;
}

/** One line of a run's stream, derived from the daemon's SSE frames. */
export interface StreamLine {
  kind: 'text' | 'tool' | 'session' | 'event';
  nodeId: string;
  /** 1 for lines produced inside a subagent. */
  depth: 0 | 1;
  text: string;
  tool?: ToolInfo;
}

export const STREAM_LIMIT = 2000;

const SUMMARY_LIMIT = 80;

/** A tool call's input as one short JSON line. */
export function summarizeInput(input: unknown): string {
  if (input === undefined) return '';
  let s: string;
  try {
    s = JSON.stringify(input) ?? String(input);
  } catch {
    s = String(input);
  }
  return s.length > SUMMARY_LIMIT ? s.slice(0, SUMMARY_LIMIT) : s;
}

/** Run events after which the dashboard refreshes the run's state. */
export const RUN_EVENT_REFRESH: ReadonlySet<string> = new Set([
  'NodeStarted',
  'NodeCompleted',
  'NodeFailed',
  'GatePassed',
  'GateFailed',
  'HumanRequested',
  'ToolApprovalRequested',
  'NodeSuspended',
  'BudgetExceeded',
  'RunCompleted',
  'RunCancelled',
]);

const depthOf = (e: { parentToolUseId?: string }): 0 | 1 => (e.parentToolUseId ? 1 : 0);

/** Applies one SSE frame to a run's lines; returns the same array when nothing changes. */
export function applyFrame(lines: readonly StreamLine[], env: Envelope): StreamLine[] {
  if (env.kind === 'run') {
    const ev = env.event;
    if (ev.type === 'NodeStarted')
      return [...lines, { kind: 'event', nodeId: ev.nodeId, depth: 0, text: `── ${ev.nodeId} ──` }];
    if (ev.type === 'ToolApprovalRequested') {
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i] as StreamLine;
        if (l.kind === 'tool' && l.nodeId === ev.nodeId && l.tool?.name === 'Bash') {
          const next = [...lines];
          next[i] = { ...l, tool: { ...(l.tool as ToolInfo), status: 'approval' } };
          return next;
        }
      }
    }
    return lines as StreamLine[];
  }
  if (env.kind !== 'runtime') return lines as StreamLine[];
  const { nodeId, event: e } = env.event;
  switch (e.type) {
    case 'text':
      return [
        ...lines,
        ...e.text
          .split('\n')
          .map((text) => ({ kind: 'text' as const, nodeId, depth: depthOf(e), text })),
      ];
    case 'tool_use':
      return [
        ...lines,
        {
          kind: 'tool',
          nodeId,
          depth: depthOf(e),
          text: e.name,
          tool: { id: e.id, name: e.name, summary: summarizeInput(e.input), status: 'running' },
        },
      ];
    case 'tool_result': {
      const failed = typeof e.output === 'object' && e.output !== null && 'error' in e.output;
      const status = failed ? 'error' : 'done';
      const i =
        e.id === undefined ? -1 : lines.findIndex((l) => l.kind === 'tool' && l.tool?.id === e.id);
      if (i >= 0) {
        const next = [...lines];
        const l = lines[i] as StreamLine;
        next[i] = { ...l, tool: { ...(l.tool as ToolInfo), status, durationMs: e.durationMs } };
        return next;
      }
      return [
        ...lines,
        {
          kind: 'tool',
          nodeId,
          depth: depthOf(e),
          text: e.name,
          tool: { id: e.id, name: e.name, summary: '', status, durationMs: e.durationMs },
        },
      ];
    }
    case 'session':
      return [...lines, { kind: 'session', nodeId, depth: 0, text: `session ${e.sessionId}` }];
    default:
      return lines as StreamLine[];
  }
}
