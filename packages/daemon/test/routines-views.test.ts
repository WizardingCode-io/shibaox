import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutinesRepo, SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { Routines } from '../src/routines.js';
import type { RunManager, SubmitRequest } from '../src/run-manager.js';

let dir: string;
let store: SqliteEventStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'routines-v-'));
  store = new SqliteEventStore(join(dir, 'e.db'));
  const repo = new RoutinesRepo(store.db);
  const submitted: SubmitRequest[] = [];
  const runs = new Map<string, { status: string; spentUsd: number; createdAt: string }>();
  let t = Date.parse('2026-10-01T09:30:00.000Z');
  let n = 0;
  const api = {
    submit: async (req: SubmitRequest) => {
      submitted.push(req);
      const runId = `run-${++n}`;
      runs.set(runId, { status: 'running', spentUsd: 0, createdAt: new Date(t).toISOString() });
      return { runId, warnings: [] };
    },
    state: async (runId: string) => {
      const r = runs.get(runId);
      if (!r) throw new Error(`run ${runId} not found`);
      return { runId, status: r.status, spentUsd: r.spentUsd };
    },
    list: async () =>
      [...runs.entries()].map(([runId, r], i) => ({
        runId,
        status: r.status,
        workflow: 'wf',
        createdAt: r.createdAt,
        updatedAt: r.createdAt,
        spentUsd: r.spentUsd,
        origin: submitted[i]?.origin,
      })),
  } as unknown as RunManager;
  const routines = new Routines({ repo, runs: api, log: () => {}, now: () => new Date(t) });
  return {
    repo,
    routines,
    submitted,
    finish: (id: string, status: string, usd: number) => {
      const r = runs.get(id);
      if (r) Object.assign(r, { status, spentUsd: usd });
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}
const base = { orgRoot: '/org', project: '/p', workflow: 'chat', input: 'report' };

describe('routines: manual, model, approvals', () => {
  it('a manual routine never fires on its own; Run now sends the model and the approval policy', async () => {
    const { routines, submitted, advance } = setup();
    const r = routines.add({
      ...base,
      trigger: { type: 'manual' },
      model: 'openai/gpt-5',
      approvals: 'auto',
      description: 'A report when asked',
    });
    expect(r.trigger).toEqual({ type: 'manual' });
    advance(3 * 60 * 60_000);
    await routines.tick();
    expect(submitted).toEqual([]);
    await routines.runNow(r.id);
    expect(submitted[0]).toMatchObject({
      workflow: 'chat',
      model: 'openai/gpt-5',
      approvals: 'auto',
      origin: `routine:${r.id}`,
    });
  });

  it('update changes what it is given, validates the cron, and detaches an org routine', () => {
    const { routines, repo } = setup();
    const r = routines.add({ ...base, trigger: { type: 'cron', cron: '0 9 * * 1' } });
    const u = routines.update(r.id, {
      name: 'Monday report',
      trigger: { type: 'cron', cron: '0 10 * * 1-5' },
      approvals: 'skip',
      intervalS: 10,
    });
    expect(u).toMatchObject({
      name: 'Monday report',
      trigger: { type: 'cron', cron: '0 10 * * 1-5' },
      approvals: 'skip',
      intervalS: 30, // the floor
      input: 'report',
    });
    expect(() => routines.update(r.id, { trigger: { type: 'cron', cron: 'nope' } })).toThrow(
      /invalid cron/,
    );
    expect(() => routines.update('missing', { name: 'x' })).toThrow(/not found/);
    const org = routines.add({
      ...base,
      id: 'org-one',
      trigger: { type: 'manual' },
      source: 'org',
    });
    routines.update(org.id, { input: 'edited here' });
    expect(repo.get('org-one')).toMatchObject({ source: 'api', input: 'edited here' });
  });

  it('views say when each routine runs next and how its last run went', async () => {
    const { routines, advance, finish } = setup();
    const cron = routines.add({ ...base, trigger: { type: 'cron', cron: '*/15 * * * *' } });
    const watcher = routines.add({
      ...base,
      trigger: { type: 'url', url: 'https://example.com' },
      intervalS: 300,
    });
    const manual = routines.add({ ...base, trigger: { type: 'manual' } });
    const paused = routines.add({
      ...base,
      trigger: { type: 'cron', cron: '0 10 * * *' },
      enabled: false,
    });
    const { runId } = await routines.runNow(manual.id);
    finish(runId, 'completed', 0.12);
    advance(60_000);
    const views = await routines.views();
    const by = Object.fromEntries(views.map((v) => [v.id, v]));
    expect(by[cron.id]?.nextRunAt).toBe('2026-10-01T09:45:00.000Z');
    expect(by[paused.id]?.nextRunAt).toBeNull();
    expect(by[manual.id]?.nextRunAt).toBeNull();
    // a watcher never looked at yet is due now; after a look, interval later
    expect(by[watcher.id]?.nextRunAt).toBe('2026-10-01T09:31:00.000Z');
    expect(by[manual.id]?.lastRun).toMatchObject({ runId, status: 'completed', spentUsd: 0.12 });
    expect(by[cron.id]?.lastRun).toBeUndefined();
  });

  it('update clears a field with null, refuses empty paths and bad models, and gives a watcher its guards', () => {
    const { routines, repo } = setup();
    const r = routines.add({
      ...base,
      trigger: { type: 'cron', cron: '0 9 * * 1' },
      model: 'openai/gpt-5',
      description: 'd',
    });
    routines.update(r.id, { model: null, description: '' });
    expect(repo.get(r.id)?.model).toBeUndefined();
    expect(repo.get(r.id)?.description).toBeUndefined();
    expect(() => routines.update(r.id, { project: '' })).toThrow(/project/);
    expect(() => routines.update(r.id, { workflow: ' ' })).toThrow(/workflow/);
    expect(() => routines.update(r.id, { model: 'gpt-5' })).toThrow(/provider\/model/);
    // cron → GitHub watcher: on_change and the daily cap, unless given
    const u = routines.update(r.id, { trigger: { type: 'github', watch: 'issues' } });
    expect(u.mode).toBe('on_change');
    expect(u.maxDailyUsd).toBe(10);
    const back = routines.update(r.id, { trigger: { type: 'cron', cron: '0 9 * * 1' } });
    expect(back.mode).toBe('always');
  });
});
