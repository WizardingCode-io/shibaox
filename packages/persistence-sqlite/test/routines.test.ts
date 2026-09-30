import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RoutinesRepo, SchedulesRepo, SqliteEventStore } from '../src/index.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('routines on disk', () => {
  it('stores every trigger kind, updates state fields, lists in creation order', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-rt-'));
    const repo = new RoutinesRepo(new SqliteEventStore(join(dir, 'e.db')).db);
    const a = repo.add({
      trigger: { type: 'github', watch: 'issues', repo: 'acme/app', label: 'bug' },
      orgRoot: '/o',
      project: '/p',
      workflow: 'fix-issue',
      input: 'fix it',
      mode: 'on_change',
      intervalS: 120,
      enabled: true,
      source: 'api',
    });
    const b = repo.add({
      id: 'nightly',
      name: 'Nightly',
      trigger: { type: 'cron', cron: '0 2 * * *' },
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'report',
      adapter: 'direct',
      budgetUsd: 2,
      maxDailyUsd: 5,
      mode: 'always',
      intervalS: 120,
      enabled: true,
      source: 'org',
    });
    expect(a.id).toMatch(/^[0-9a-f]{8}$/);
    expect(b.id).toBe('nightly');
    expect(repo.list().map((r) => r.id)).toEqual([a.id, 'nightly']);
    expect(repo.get('nightly')).toMatchObject({
      name: 'Nightly',
      trigger: { type: 'cron', cron: '0 2 * * *' },
      maxDailyUsd: 5,
      source: 'org',
    });
    repo.update(a.id, {
      lastFingerprint: 'abc',
      lastCheckedAt: 't1',
      lastRunId: 'r1',
      lastFiredAt: 't1',
      enabled: false,
    });
    expect(repo.get(a.id)).toMatchObject({
      lastFingerprint: 'abc',
      lastCheckedAt: 't1',
      lastRunId: 'r1',
      lastFiredAt: 't1',
      enabled: false,
    });
    expect(repo.remove('nightly')).toBe(true);
    expect(repo.remove('nightly')).toBe(false);
    expect(repo.list()).toHaveLength(1);
  });
  it('migrates the old schedules table into cron routines once, keeping ids and last runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-rt-'));
    const db = new SqliteEventStore(join(dir, 'e.db')).db;
    const old = new SchedulesRepo(db);
    old.add({
      id: 'sch1',
      cron: '0 9 * * 1-5',
      orgRoot: '/o',
      project: '/p',
      workflow: 'wf',
      input: 'hi',
      adapter: 'mock',
      budgetUsd: 1,
      enabled: true,
      lastRunId: 'r9',
    });
    const repo = new RoutinesRepo(db);
    expect(repo.migrateSchedules()).toBe(1);
    expect(repo.get('sch1')).toMatchObject({
      trigger: { type: 'cron', cron: '0 9 * * 1-5' },
      workflow: 'wf',
      input: 'hi',
      adapter: 'mock',
      budgetUsd: 1,
      enabled: true,
      lastRunId: 'r9',
      mode: 'always',
      source: 'api',
    });
    expect(old.list()).toEqual([]); // moved, not copied
    expect(repo.migrateSchedules()).toBe(0);
  });
});
