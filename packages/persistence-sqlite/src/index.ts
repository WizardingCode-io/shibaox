import { type EventStore, notify, type RunSummary, replay, type StoredEvent } from '@shibaox/core';
import { type RunEvent, RunEventSchema } from '@shibaox/schemas';
import Database from 'better-sqlite3';

export class SqliteEventStore implements EventStore {
  readonly db: Database.Database;
  private readonly listeners = new Set<(e: StoredEvent) => void>();

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);`);
  }

  async append(event: RunEvent): Promise<StoredEvent> {
    const parsed = RunEventSchema.parse(event);
    const info = this.db
      .prepare('INSERT INTO events (run_id, type, at, payload) VALUES (?, ?, ?, ?)')
      .run(parsed.runId, parsed.type, parsed.at, JSON.stringify(parsed));
    const stored = { ...parsed, seq: Number(info.lastInsertRowid) };
    notify(this.listeners, stored);
    return stored;
  }

  subscribe(listener: (e: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async read(runId: string): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare('SELECT seq, payload FROM events WHERE run_id = ? ORDER BY seq')
      .all(runId) as { seq: number; payload: string }[];
    return rows.map((r) => ({ ...(JSON.parse(r.payload) as RunEvent), seq: r.seq }));
  }

  async listRuns(): Promise<RunSummary[]> {
    const ids = this.db
      .prepare('SELECT run_id FROM events GROUP BY run_id ORDER BY MIN(seq)')
      .all() as { run_id: string }[];
    const out: RunSummary[] = [];
    for (const { run_id } of ids) {
      const events = await this.read(run_id);
      const state = replay(events);
      out.push({
        runId: run_id,
        workflow: state.workflow,
        status: state.status,
        createdAt: events[0]!.at,
        updatedAt: events[events.length - 1]!.at,
      });
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}
export * from './outbox.js';
export * from './schedules.js';
