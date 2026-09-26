import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutboxRepo, SchedulesRepo, SqliteEventStore } from '../src/index.js';

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
