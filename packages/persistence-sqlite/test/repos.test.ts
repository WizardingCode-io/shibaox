import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutboxRepo, RuntimeEventsRepo, SchedulesRepo, SqliteEventStore } from '../src/index.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sqlite repos', () => {
  it('subscribe receives appended events and unsubscribes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const seen: string[] = [];
    const off = store.subscribe((e) => seen.push(`${e.type}:${e.seq}`));
    await store.append({
      type: 'RunCreated',
      runId: 'r',
      at: 'x',
      workflow: 'w',
      input: {},
      workspace: '/w',
    });
    off();
    await store.append({ type: 'RunStarted', runId: 'r', at: 'x' });
    expect(seen).toEqual(['RunCreated:1']);
    store.close();
  });

  it('schedules round-trip', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const schedules = new SchedulesRepo(store.db);
    const s = schedules.add({
      cron: '0 9 * * 1-5',
      orgRoot: '/org',
      project: '/p',
      workflow: 'wf',
      input: 'hi',
      enabled: true,
    });
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    expect(schedules.list()).toEqual([s]);
    expect(schedules.get(s.id)).toMatchObject({ cron: '0 9 * * 1-5', adapter: undefined });
    schedules.setLastRun(s.id, 'run-1');
    expect(schedules.get(s.id)?.lastRunId).toBe('run-1');
    schedules.setEnabled(s.id, false);
    expect(schedules.get(s.id)?.enabled).toBe(false);
    expect(schedules.remove(s.id)).toBe(true);
    expect(schedules.remove(s.id)).toBe(false);
    // the repo survives reopening
    const again = new SchedulesRepo(store.db);
    expect(again.list()).toEqual([]);
    store.close();
  });

  it('outbox due/retry/remove', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const outbox = new OutboxRepo(store.db);
    const row = outbox.enqueue('telegram', 'approval:a1', { text: 'hi' });
    expect(row).toMatchObject({ channel: 'telegram', inboxId: 'approval:a1', attempts: 0 });
    expect(JSON.parse(row.payload)).toEqual({ text: 'hi' });
    expect(outbox.due('2099-01-01T00:00:00.000Z')).toHaveLength(1);
    outbox.retry(row.id, '2099-01-02T00:00:00.000Z');
    expect(outbox.due('2099-01-01T00:00:00.000Z')).toHaveLength(0);
    expect(outbox.due('2099-01-03T00:00:00.000Z')[0]?.attempts).toBe(1);
    outbox.enqueue('macos', 'approval:a1', {});
    outbox.removeForInbox('approval:a1');
    expect(outbox.due('2100-01-01T00:00:00.000Z')).toHaveLength(0);
    const r2 = outbox.enqueue('macos', 'human:r:ship', {});
    outbox.remove(r2.id);
    expect(outbox.due('2100-01-01T00:00:00.000Z')).toHaveLength(0);
    store.close();
  });
});

describe('runtime events on disk', () => {
  it("keeps every run's tool calls across instances, numbered per run, trimmed", async () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new RuntimeEventsRepo(store.db);
    expect(repo.nextSeq('r1')).toBe(1);
    repo.append({ runId: 'r1', nodeId: 'a', seq: 1, at: 't1', event: { type: 'started' } });
    repo.append({
      runId: 'r1',
      nodeId: 'a',
      seq: 2,
      at: 't2',
      event: { type: 'tool_use', name: 'read_file', input: { path: 'x' } },
    });
    repo.append({
      runId: 'r1',
      nodeId: 'a',
      seq: 3,
      at: 't3',
      event: { type: 'tool_result', name: 'read_file', output: 'y'.repeat(10_000), durationMs: 7 },
    });
    repo.append({ runId: 'r2', nodeId: 'b', seq: 1, at: 't1', event: { type: 'started' } });
    store.close();
    const again = new RuntimeEventsRepo(new SqliteEventStore(join(dir, 'e.db')).db);
    const r1 = again.read('r1');
    expect(r1.map((e) => [e.seq, e.event.type])).toEqual([
      [1, 'started'],
      [2, 'tool_use'],
      [3, 'tool_result'],
    ]);
    expect(r1[2]?.event).toMatchObject({ durationMs: 7 });
    const third = r1[2]?.event as { output: string } | undefined;
    expect(third?.output.length ?? 0).toBeLessThan(5000); // clipped for storage, like the buffer
    expect(third?.output.length ?? 0).toBeGreaterThan(4000);
    expect(again.read('r1', 2).map((e) => e.seq)).toEqual([3]);
    expect(again.nextSeq('r1')).toBe(4);
    again.append({
      runId: 'r1',
      nodeId: 'a',
      seq: 4,
      at: 't4',
      event: { type: 'tool_use', name: 'write_file', input: { content: 'z'.repeat(10_000) } },
    });
    const big = again.read('r1', 3)[0]?.event as { input: unknown } | undefined;
    expect(JSON.stringify(big?.input).length).toBeLessThan(5000); // inputs are clipped too
    expect(again.read('r1', 3, ['tool_use']).map((e) => e.seq)).toEqual([4]); // by type, in SQL
    expect(again.read('r1', 0, ['text'])).toEqual([]);
    expect(again.nextSeq('r1')).toBe(5);
    expect(again.read('r2')).toHaveLength(1);
  });

  it('prune removes finished runs older than a date, with their runtime events; live and newer runs stay', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new RuntimeEventsRepo(store.db);
    const created = (runId: string, at: string) =>
      store.append({ type: 'RunCreated', runId, at, workflow: 'w', input: {}, workspace: '/w' });
    await created('old-done', '2026-01-01T00:00:00.000Z');
    await store.append({ type: 'RunStarted', runId: 'old-done', at: '2026-01-01T00:00:01.000Z' });
    await store.append({ type: 'RunCompleted', runId: 'old-done', at: '2026-01-02T00:00:00.000Z' });
    repo.append({ runId: 'old-done', nodeId: 'a', seq: 1, at: 'x', event: { type: 'started' } });
    await created('old-live', '2026-01-01T00:00:00.000Z');
    await store.append({ type: 'RunStarted', runId: 'old-live', at: '2026-01-01T00:00:01.000Z' });
    await created('new-done', '2026-09-01T00:00:00.000Z');
    await store.append({ type: 'RunCompleted', runId: 'new-done', at: '2026-09-02T00:00:00.000Z' });
    const removed = await store.prune('2026-06-01T00:00:00.000Z');
    expect(removed).toEqual(['old-done']);
    expect((await store.listRuns()).map((r) => r.runId).sort()).toEqual(['new-done', 'old-live']);
    expect(repo.read('old-done')).toEqual([]);
    expect(await store.read('old-done')).toEqual([]);
  });
});
