import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ScheduleRow {
  id: string;
  cron: string;
  orgRoot: string;
  project: string;
  workflow: string;
  input: string;
  adapter?: string;
  budgetUsd?: number;
  enabled: boolean;
  lastRunId?: string;
  createdAt: string;
}

interface Raw {
  id: string;
  cron: string;
  org_root: string;
  project: string;
  workflow: string;
  input: string;
  adapter: string | null;
  budget_usd: number | null;
  enabled: number;
  last_run_id: string | null;
  created_at: string;
}

const toRow = (r: Raw): ScheduleRow => ({
  id: r.id,
  cron: r.cron,
  orgRoot: r.org_root,
  project: r.project,
  workflow: r.workflow,
  input: r.input,
  adapter: r.adapter ?? undefined,
  budgetUsd: r.budget_usd ?? undefined,
  enabled: r.enabled === 1,
  lastRunId: r.last_run_id ?? undefined,
  createdAt: r.created_at,
});

/** Cron schedules that submit runs (see the daemon's Scheduler). */
export class SchedulesRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, cron TEXT NOT NULL, org_root TEXT NOT NULL, project TEXT NOT NULL,
      workflow TEXT NOT NULL, input TEXT NOT NULL, adapter TEXT, budget_usd REAL,
      enabled INTEGER NOT NULL DEFAULT 1, last_run_id TEXT, created_at TEXT NOT NULL)`);
  }

  list(): ScheduleRow[] {
    return (this.db.prepare('SELECT * FROM schedules ORDER BY created_at, id').all() as Raw[]).map(
      toRow,
    );
  }

  get(id: string): ScheduleRow | undefined {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  add(row: Omit<ScheduleRow, 'id' | 'createdAt'> & { id?: string }): ScheduleRow {
    const id = row.id ?? randomUUID().replace(/-/g, '').slice(0, 8);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO schedules (id, cron, org_root, project, workflow, input, adapter, budget_usd, enabled, last_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.cron,
        row.orgRoot,
        row.project,
        row.workflow,
        row.input,
        row.adapter ?? null,
        row.budgetUsd ?? null,
        row.enabled ? 1 : 0,
        row.lastRunId ?? null,
        createdAt,
      );
    return { ...row, id, createdAt };
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  setLastRun(id: string, runId: string): void {
    this.db.prepare('UPDATE schedules SET last_run_id = ? WHERE id = ?').run(runId, id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }
}
