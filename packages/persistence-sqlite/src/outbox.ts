import type Database from 'better-sqlite3';

export interface OutboxRow {
  id: number;
  channel: string;
  inboxId: string;
  /** JSON of what the channel is asked to send. */
  payload: string;
  attempts: number;
  nextAt: string;
}

interface Raw {
  id: number;
  channel: string;
  inbox_id: string;
  payload: string;
  attempts: number;
  next_at: string;
}

const toRow = (r: Raw): OutboxRow => ({
  id: r.id,
  channel: r.channel,
  inboxId: r.inbox_id,
  payload: r.payload,
  attempts: r.attempts,
  nextAt: r.next_at,
});

/** Pending channel notifications, retried with backoff by the daemon's OutboxWorker. */
export class OutboxRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS channel_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, inbox_id TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_next ON channel_outbox(next_at)`);
  }

  enqueue(channel: string, inboxId: string, payload: unknown, nextAt?: string): OutboxRow {
    nextAt ??= new Date().toISOString();
    const json = JSON.stringify(payload);
    const info = this.db
      .prepare(
        'INSERT INTO channel_outbox (channel, inbox_id, payload, attempts, next_at) VALUES (?, ?, ?, 0, ?)',
      )
      .run(channel, inboxId, json, nextAt);
    return {
      id: Number(info.lastInsertRowid),
      channel,
      inboxId,
      payload: json,
      attempts: 0,
      nextAt,
    };
  }

  due(now: string): OutboxRow[] {
    return (
      this.db
        .prepare('SELECT * FROM channel_outbox WHERE next_at <= ? ORDER BY id')
        .all(now) as Raw[]
    ).map(toRow);
  }

  retry(id: number, nextAt: string): void {
    this.db
      .prepare('UPDATE channel_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?')
      .run(nextAt, id);
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM channel_outbox WHERE id = ?').run(id);
  }

  removeForInbox(inboxId: string): void {
    this.db.prepare('DELETE FROM channel_outbox WHERE inbox_id = ?').run(inboxId);
  }
}
