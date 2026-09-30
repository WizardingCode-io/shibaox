import type { RuntimeEvent } from '@wizardingcode/shibaox-core';
import type Database from 'better-sqlite3';

/** A runtime event of a run, numbered per run from 1 (the same shape the daemon streams). */
export interface StoredRuntimeEvent {
  runId: string;
  nodeId: string;
  seq: number;
  at: string;
  event: RuntimeEvent;
}

/** Texts and tool outputs are stored clipped: the table is for the dashboard and the audit, not a transcript. */
export const RUNTIME_TEXT_LIMIT = 4096;
const clip = (s: string) =>
  s.length > RUNTIME_TEXT_LIMIT ? `${s.slice(0, RUNTIME_TEXT_LIMIT)}…` : s;
const trim = (event: RuntimeEvent): RuntimeEvent => {
  if (event.type === 'text') return { ...event, text: clip(event.text) };
  if (event.type === 'tool_result') {
    const s =
      typeof event.output === 'string' ? event.output : (JSON.stringify(event.output) ?? '');
    return s.length > RUNTIME_TEXT_LIMIT ? { ...event, output: clip(s) } : event;
  }
  return event;
};

interface Raw {
  run_id: string;
  node_id: string;
  seq: number;
  at: string;
  payload: string;
}

/**
 * Every runtime event (tool calls, texts, usage) of every run, on disk next to the run log, so
 * a restart forgets nothing the dashboard or `shibaox audit` will ask for.
 */
export class RuntimeEventsRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_events (
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    );`);
  }

  append(e: StoredRuntimeEvent): void {
    const event = trim(e.event);
    this.db
      .prepare(
        'INSERT OR REPLACE INTO runtime_events (run_id, node_id, seq, at, type, payload) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(e.runId, e.nodeId, e.seq, e.at, event.type, JSON.stringify(event));
  }

  /** Events with `seq > since`, in order. */
  read(runId: string, since = 0): StoredRuntimeEvent[] {
    const rows = this.db
      .prepare(
        'SELECT run_id, node_id, seq, at, payload FROM runtime_events WHERE run_id = ? AND seq > ? ORDER BY seq',
      )
      .all(runId, since) as Raw[];
    return rows.map((r) => ({
      runId: r.run_id,
      nodeId: r.node_id,
      seq: r.seq,
      at: r.at,
      event: JSON.parse(r.payload) as RuntimeEvent,
    }));
  }

  /** The number the next event of the run gets (a resumed run keeps counting). */
  nextSeq(runId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS m FROM runtime_events WHERE run_id = ?')
      .get(runId) as { m: number | null };
    return (row.m ?? 0) + 1;
  }

  forget(runIds: string[]): void {
    const del = this.db.prepare('DELETE FROM runtime_events WHERE run_id = ?');
    for (const id of runIds) del.run(id);
  }
}
