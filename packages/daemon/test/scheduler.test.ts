import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SchedulesRepo, SqliteEventStore } from '@shibaox/persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunManager, SubmitRequest } from '../src/run-manager.js';
import { Scheduler } from '../src/scheduler.js';

let dir: string;
let store: SqliteEventStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeRuns(statusOf: (runId: string) => string) {
  const submitted: SubmitRequest[] = [];
  let n = 0;
  const runs = {
    submit: async (req: SubmitRequest) => {
      submitted.push(req);
      return { runId: `run-${++n}`, warnings: [] };
    },
    state: async (runId: string) => ({ runId, status: statusOf(runId) }),
  } as unknown as RunManager;
  return { runs, submitted };
}

function setup(statusOf: (runId: string) => string = () => 'completed') {
  dir = mkdtempSync(join(tmpdir(), 'sched-'));
  store = new SqliteEventStore(join(dir, 'e.db'));
  const repo = new SchedulesRepo(store.db);
  const { runs, submitted } = fakeRuns(statusOf);
  let t = Date.parse('2026-09-26T10:00:30.000Z');
  const logs: string[] = [];
  const scheduler = new Scheduler({ repo, runs, log: (l) => logs.push(l), now: () => new Date(t) });
  return { repo, scheduler, submitted, logs, advance: (ms: number) => (t += ms) };
}

const every = { cron: '* * * * *', orgRoot: '/org', project: '/p', workflow: 'wf', input: 'hi' };

describe('Scheduler', () => {
  it('submits a due schedule once per occurrence and records the run', async () => {
    const { repo, scheduler, submitted, advance } = setup();
    const s = scheduler.add({ ...every, adapter: 'mock', budgetUsd: 2 });
    await scheduler.tick();
    expect(submitted).toEqual([]); // 10:00:30 → next occurrence is 10:01
    advance(30_000);
    await scheduler.tick();
    expect(submitted).toEqual([
      {
        orgRoot: '/org',
        project: '/p',
        workflow: 'wf',
        input: 'hi',
        adapter: 'mock',
        budgetUsd: 2,
        origin: `schedule:${s.id}`,
      },
    ]);
    expect(repo.get(s.id)?.lastRunId).toBe('run-1');
    await scheduler.tick(); // same minute: nothing new
    expect(submitted).toHaveLength(1);
    advance(60_000);
    await scheduler.tick();
    expect(submitted).toHaveLength(2);
  });

  it('skips when the previous run is still active and logs it', async () => {
    const { scheduler, submitted, logs, advance } = setup(() => 'running');
    const s = scheduler.add(every);
    advance(30_000);
    await scheduler.tick();
    advance(60_000);
    await scheduler.tick();
    expect(submitted).toHaveLength(1);
    expect(logs).toContain(`Skipped schedule ${s.id}: previous run run-1 is still running`);
  });

  it('disabled schedules never fire; runNow submits immediately', async () => {
    const { repo, scheduler, submitted, advance } = setup();
    const s = scheduler.add({ ...every, enabled: false });
    advance(30_000);
    await scheduler.tick();
    expect(submitted).toEqual([]);
    expect(await scheduler.runNow(s.id)).toEqual({ runId: 'run-1' });
    expect(repo.get(s.id)?.lastRunId).toBe('run-1');
    scheduler.remove(s.id);
    expect(scheduler.list()).toEqual([]);
    await expect(scheduler.runNow(s.id)).rejects.toThrow(`schedule ${s.id} not found`);
  });

  it('rejects an invalid cron expression', () => {
    const { scheduler } = setup();
    expect(() => scheduler.add({ ...every, cron: 'not a cron' })).toThrow(
      'invalid cron expression: not a cron',
    );
  });
});
