import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoutinesRepo, SqliteEventStore } from '../src/index.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('routines: model, approvals, description', () => {
  it('round-trip, update, and the manual trigger', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-rtf-'));
    const repo = new RoutinesRepo(new SqliteEventStore(join(dir, 'e.db')).db);
    const r = repo.add({
      trigger: { type: 'manual' },
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'report',
      description: 'A report',
      model: 'openai/gpt-5',
      approvals: 'skip',
      mode: 'always',
      intervalS: 120,
      enabled: true,
      source: 'api',
    });
    expect(repo.get(r.id)).toMatchObject({
      trigger: { type: 'manual' },
      description: 'A report',
      model: 'openai/gpt-5',
      approvals: 'skip',
    });
    repo.update(r.id, { approvals: 'inbox', model: null, description: null });
    expect(repo.get(r.id)).toMatchObject({ approvals: 'inbox' });
    expect(repo.get(r.id)?.model).toBeUndefined();
    expect(repo.get(r.id)?.description).toBeUndefined();
  });

  it('a table from 0.2.3 (without the columns) is migrated in place', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-rtm-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    store.db.exec(`CREATE TABLE routines (
      id TEXT PRIMARY KEY, name TEXT, trigger TEXT NOT NULL, org_root TEXT NOT NULL,
      project TEXT NOT NULL, workflow TEXT NOT NULL, input TEXT NOT NULL, adapter TEXT,
      budget_usd REAL, max_daily_usd REAL, mode TEXT NOT NULL, interval_s INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, last_run_id TEXT,
      last_fingerprint TEXT, last_checked_at TEXT, last_fired_at TEXT, created_at TEXT NOT NULL)`);
    store.db
      .prepare(
        `INSERT INTO routines (id, trigger, org_root, project, workflow, input, mode, interval_s, enabled, source, created_at)
         VALUES ('old', '{"type":"cron","cron":"0 9 * * 1"}', '/o', '/p', 'wf', '', 'always', 120, 1, 'api', '2026-09-30T00:00:00.000Z')`,
      )
      .run();
    const repo = new RoutinesRepo(store.db);
    const old = repo.get('old');
    expect(old?.approvals).toBeUndefined();
    expect(old?.model).toBeUndefined();
    repo.update('old', { approvals: 'auto' });
    expect(repo.get('old')?.approvals).toBe('auto');
  });
});
