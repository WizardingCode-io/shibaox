import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutboxRepo, SqliteEventStore } from '@shibaox/persistence-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKOFF_MS, OutboxWorker } from '../src/channels/outbox.js';
import type { Channel } from '../src/channels/types.js';
import type { InboxItem } from '../src/inbox.js';
import type { RunReport } from '../src/runs/report.js';

let dir: string;
let store: SqliteEventStore;
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const item: InboxItem = {
  id: 'approval:a1',
  kind: 'approval',
  runId: 'r',
  nodeId: 'n',
  at: 'x',
  prompt: 'git push',
  detail: {},
};

function flaky(failures: number): Channel & { sent: string[] } {
  let left = failures;
  const sent: string[] = [];
  return {
    id: 'telegram',
    sent,
    async notify(i) {
      if (left-- > 0) throw new Error('network down');
      sent.push(i.id);
    },
  };
}

describe('OutboxWorker', () => {
  it('retries a failing channel with backoff and removes the row on success', async () => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new OutboxRepo(store.db);
    const channel = flaky(2);
    let t = Date.parse('2026-09-26T00:00:00.000Z');
    const worker = new OutboxWorker({
      repo,
      channels: [channel],
      log: () => {},
      now: () => new Date(t),
    });
    worker.enqueue(item);
    await worker.tick();
    expect(channel.sent).toEqual([]);
    const [row] = repo.due('2100-01-01T00:00:00.000Z');
    expect(row?.attempts).toBe(1);
    expect(Date.parse(row?.nextAt ?? '')).toBe(t + (BACKOFF_MS[0] as number));
    await worker.tick(); // not due yet
    expect(row && repo.due(new Date(t).toISOString())).toEqual([]);
    t += BACKOFF_MS[0] as number;
    await worker.tick();
    expect(repo.due('2100-01-01T00:00:00.000Z')[0]?.attempts).toBe(2);
    t += BACKOFF_MS[1] as number;
    await worker.tick();
    expect(channel.sent).toEqual(['approval:a1']);
    expect(repo.due('2100-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('enqueues one row per channel and clear drops them all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new OutboxRepo(store.db);
    const a = flaky(99);
    const b: Channel = { ...flaky(99), id: 'macos' };
    const worker = new OutboxWorker({ repo, channels: [a, b], log: () => {} });
    worker.enqueue(item);
    expect(repo.due('2100-01-01T00:00:00.000Z').map((r) => r.channel)).toEqual([
      'telegram',
      'macos',
    ]);
    worker.clear(item.id);
    expect(repo.due('2100-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('reports go only to channels that implement report(); legacy inbox rows still notify', async () => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new OutboxRepo(store.db);
    const reported: string[] = [];
    const notified: string[] = [];
    const telegram: Channel = {
      id: 'telegram',
      async notify(i) {
        notified.push(i.id);
      },
      async report(r) {
        reported.push(r.runId);
      },
    };
    const macos: Channel = {
      id: 'macos',
      async notify(i) {
        notified.push(`macos:${i.id}`);
      },
    };
    const report: RunReport = {
      runId: 'run-1',
      workflow: 'chat',
      status: 'completed',
      project: '/w',
      spentUsd: 0,
      nodes: [],
      reply: 'hi',
    };
    // a row written before 3B: a bare InboxItem payload
    repo.enqueue('telegram', item.id, item);
    const worker = new OutboxWorker({ repo, channels: [telegram, macos], log: () => {} });
    worker.enqueueReport(report);
    expect(repo.due('2100-01-01T00:00:00.000Z').map((r) => r.channel)).toEqual([
      'telegram',
      'telegram',
    ]);
    await worker.tick();
    expect(notified).toEqual(['approval:a1']);
    expect(reported).toEqual(['run-1']);
    expect(repo.due('2100-01-01T00:00:00.000Z')).toEqual([]);
  });

  it('a row for a channel that no longer exists is dropped', async () => {
    dir = mkdtempSync(join(tmpdir(), 'outbox-'));
    store = new SqliteEventStore(join(dir, 'e.db'));
    const repo = new OutboxRepo(store.db);
    repo.enqueue('telegram', item.id, item);
    const worker = new OutboxWorker({ repo, channels: [], log: () => {} });
    await worker.tick();
    expect(repo.due('2100-01-01T00:00:00.000Z')).toEqual([]);
  });
});
