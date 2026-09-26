import type { RuntimeEvent } from '@shibaox/core';

/** Texts and tool outputs are stored trimmed: the log keeps the full versions, the buffer is for display. */
export const STORED_TEXT_LIMIT = 4096;

const clip = (s: string) =>
  s.length > STORED_TEXT_LIMIT ? `${s.slice(0, STORED_TEXT_LIMIT)}…` : s;

/** A copy of the event with long texts and tool outputs clipped. */
export function trimForStorage(event: RuntimeEvent): RuntimeEvent {
  if (event.type === 'text') return { ...event, text: clip(event.text) };
  if (event.type === 'tool_result') {
    const s =
      typeof event.output === 'string' ? event.output : (JSON.stringify(event.output) ?? '');
    return s.length > STORED_TEXT_LIMIT ? { ...event, output: clip(s) } : event;
  }
  return event;
}

export interface RuntimeEnvelope {
  runId: string;
  nodeId: string;
  /** Per-run sequence, from 1. */
  seq: number;
  at: string;
  event: RuntimeEvent;
}

/** The last `capacity` runtime events of each run, so a late `follow` can catch up. */
export class RuntimeBuffer {
  private readonly runs = new Map<string, { seq: number; events: RuntimeEnvelope[] }>();
  /** Finished runs whose buffer is kept (oldest first); beyond `keepFinished` they are dropped. */
  private readonly finished: string[] = [];

  constructor(
    private readonly capacity = 2000,
    private readonly keepFinished = 50,
  ) {}

  /** The run ended: keep its stream for `follow`/the dashboard, dropping the oldest finished ones. */
  retire(runId: string): void {
    if (!this.runs.has(runId) || this.finished.includes(runId)) return;
    this.finished.push(runId);
    while (this.finished.length > this.keepFinished) {
      const old = this.finished.shift();
      if (old) this.runs.delete(old);
    }
  }

  push(runId: string, nodeId: string, event: RuntimeEvent, at: string): RuntimeEnvelope {
    // a retired run that runs again is live: it must not be evicted by later retirements
    const idx = this.finished.indexOf(runId);
    if (idx >= 0) this.finished.splice(idx, 1);
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = { seq: 0, events: [] };
      this.runs.set(runId, entry);
    }
    const envelope: RuntimeEnvelope = {
      runId,
      nodeId,
      seq: ++entry.seq,
      at,
      event: trimForStorage(event),
    };
    entry.events.push(envelope);
    if (entry.events.length > this.capacity)
      entry.events.splice(0, entry.events.length - this.capacity);
    return envelope;
  }

  /** Events with `seq > since`. */
  read(runId: string, since = 0): RuntimeEnvelope[] {
    return (this.runs.get(runId)?.events ?? []).filter((e) => e.seq > since);
  }
}
