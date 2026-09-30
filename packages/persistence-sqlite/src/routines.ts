import { randomUUID } from 'node:crypto';
import type { RoutineTrigger } from '@wizardingcode/shibaox-schemas';
import type Database from 'better-sqlite3';

export type RoutineMode = 'always' | 'on_change';

export interface RoutineRow {
  id: string;
  name?: string;
  trigger: RoutineTrigger;
  orgRoot: string;
  project: string;
  workflow: string;
  input: string;
  adapter?: string;
  budgetUsd?: number;
  maxDailyUsd?: number;
  mode: RoutineMode;
  /** Seconds between looks (watchers). */
  intervalS: number;
  enabled: boolean;
  /** `org`: from `org/routines/*.yaml` (sync owns it); `api`: added by hand. */
  source: 'api' | 'org';
  lastRunId?: string;
  lastFingerprint?: string;
  lastCheckedAt?: string;
  lastFiredAt?: string;
  createdAt: string;
}

interface Raw {
  id: string;
  name: string | null;
  trigger: string;
  org_root: string;
  project: string;
  workflow: string;
  input: string;
  adapter: string | null;
  budget_usd: number | null;
  max_daily_usd: number | null;
  mode: string;
  interval_s: number;
  enabled: number;
  source: string;
  last_run_id: string | null;
  last_fingerprint: string | null;
  last_checked_at: string | null;
  last_fired_at: string | null;
  created_at: string;
}

const toRow = (r: Raw): RoutineRow => ({
  id: r.id,
  name: r.name ?? undefined,
  trigger: JSON.parse(r.trigger) as RoutineTrigger,
  orgRoot: r.org_root,
  project: r.project,
  workflow: r.workflow,
  input: r.input,
  adapter: r.adapter ?? undefined,
  budgetUsd: r.budget_usd ?? undefined,
  maxDailyUsd: r.max_daily_usd ?? undefined,
  mode: r.mode as RoutineMode,
  intervalS: r.interval_s,
  enabled: r.enabled === 1,
  source: r.source as 'api' | 'org',
  lastRunId: r.last_run_id ?? undefined,
  lastFingerprint: r.last_fingerprint ?? undefined,
  lastCheckedAt: r.last_checked_at ?? undefined,
  lastFiredAt: r.last_fired_at ?? undefined,
  createdAt: r.created_at,
});

export type RoutineInsert = Omit<RoutineRow, 'id' | 'createdAt'> & { id?: string };

/** Routines: what the daemon wakes up for (cron, GitHub, a URL, a file, a command). */
export class RoutinesRepo {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY, name TEXT, trigger TEXT NOT NULL, org_root TEXT NOT NULL,
      project TEXT NOT NULL, workflow TEXT NOT NULL, input TEXT NOT NULL, adapter TEXT,
      budget_usd REAL, max_daily_usd REAL, mode TEXT NOT NULL, interval_s INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, last_run_id TEXT,
      last_fingerprint TEXT, last_checked_at TEXT, last_fired_at TEXT, created_at TEXT NOT NULL)`);
  }

  list(): RoutineRow[] {
    return (
      this.db.prepare('SELECT * FROM routines ORDER BY created_at, rowid').all() as Raw[]
    ).map(toRow);
  }

  get(id: string): RoutineRow | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  add(row: RoutineInsert): RoutineRow {
    const id = row.id ?? randomUUID().replace(/-/g, '').slice(0, 8);
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO routines (id, name, trigger, org_root, project, workflow, input, adapter, budget_usd,
          max_daily_usd, mode, interval_s, enabled, source, last_run_id, last_fingerprint, last_checked_at,
          last_fired_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.name ?? null,
        JSON.stringify(row.trigger),
        row.orgRoot,
        row.project,
        row.workflow,
        row.input,
        row.adapter ?? null,
        row.budgetUsd ?? null,
        row.maxDailyUsd ?? null,
        row.mode,
        row.intervalS,
        row.enabled ? 1 : 0,
        row.source,
        row.lastRunId ?? null,
        row.lastFingerprint ?? null,
        row.lastCheckedAt ?? null,
        row.lastFiredAt ?? null,
        createdAt,
      );
    return { ...row, id, createdAt };
  }

  /** Changes the given fields only. */
  update(id: string, patch: Partial<Omit<RoutineRow, 'id' | 'createdAt'>>): void {
    const cols: Record<string, unknown> = {};
    const map: Record<string, string> = {
      name: 'name',
      trigger: 'trigger',
      orgRoot: 'org_root',
      project: 'project',
      workflow: 'workflow',
      input: 'input',
      adapter: 'adapter',
      budgetUsd: 'budget_usd',
      maxDailyUsd: 'max_daily_usd',
      mode: 'mode',
      intervalS: 'interval_s',
      enabled: 'enabled',
      source: 'source',
      lastRunId: 'last_run_id',
      lastFingerprint: 'last_fingerprint',
      lastCheckedAt: 'last_checked_at',
      lastFiredAt: 'last_fired_at',
    };
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col || v === undefined) continue;
      cols[col] = k === 'trigger' ? JSON.stringify(v) : k === 'enabled' ? (v ? 1 : 0) : v;
    }
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    this.db
      .prepare(`UPDATE routines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => cols[k] ?? null), id);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0;
  }

  /** Moves the rows of the old `schedules` table here as cron routines (ids kept); returns how many. */
  migrateSchedules(): number {
    const exists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schedules'")
      .get();
    if (!exists) return 0;
    const rows = this.db.prepare('SELECT * FROM schedules').all() as {
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
    }[];
    let n = 0;
    const move = this.db.transaction(() => {
      for (const r of rows) {
        if (this.get(r.id)) continue;
        this.add({
          id: r.id,
          trigger: { type: 'cron', cron: r.cron },
          orgRoot: r.org_root,
          project: r.project,
          workflow: r.workflow,
          input: r.input,
          adapter: r.adapter ?? undefined,
          budgetUsd: r.budget_usd ?? undefined,
          mode: 'always',
          intervalS: 120,
          enabled: r.enabled === 1,
          source: 'api',
          lastRunId: r.last_run_id ?? undefined,
        });
        this.db.prepare('DELETE FROM schedules WHERE id = ?').run(r.id);
        n++;
      }
    });
    move();
    return n;
  }
}
