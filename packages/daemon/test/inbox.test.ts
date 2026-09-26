import { MemoryEventStore } from '@shibaox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlreadyResolvedError, InboxService, NotFoundError } from '../src/inbox.js';

const req = {
  runId: 'r1',
  nodeId: 'impl',
  role: 'backend',
  tool: 'Bash' as const,
  program: 'git',
  category: 'push' as const,
  command: 'git push origin main',
  argv: ['git', 'push', 'origin', 'main'],
};

async function seedRun(store: MemoryEventStore, runId = 'r1') {
  await store.append({
    type: 'RunCreated',
    runId,
    at: 'x',
    workflow: 'wf',
    input: {},
    workspace: '/w',
  });
  await store.append({ type: 'RunStarted', runId, at: 'x' });
  await store.append({ type: 'NodeStarted', runId, nodeId: 'impl', at: 'x' });
}

afterEach(() => vi.useRealTimers());

describe('InboxService', () => {
  it('request appends ToolApprovalRequested, lists it, and answer resolves the blocked promise', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    const items: unknown[] = [];
    const inbox = new InboxService({
      store,
      approvalTimeoutMs: 60_000,
      newId: () => 'a1',
      now: () => '2026-09-26T00:00:00.000Z',
      onItem: (i) => items.push(i),
    });
    const p = inbox.request(req, {});
    await vi.waitFor(async () => expect(await inbox.list()).toHaveLength(1));
    expect(await inbox.list()).toMatchObject([
      {
        id: 'approval:a1',
        kind: 'approval',
        runId: 'r1',
        nodeId: 'impl',
        prompt: 'git push origin main',
        detail: { program: 'git', category: 'push', role: 'backend' },
      },
    ]);
    expect(items).toHaveLength(1);
    expect(inbox.hasBlocked('a1')).toBe(true);
    const stored = (await store.read('r1')).at(-1);
    expect(stored).toMatchObject({
      type: 'ToolApprovalRequested',
      approvalId: 'a1',
      argvHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await inbox.answer('approval:a1', { approved: true, note: 'ok', via: 'cli' })).toEqual({
      runId: 'r1',
      kind: 'approval',
    });
    expect(await p).toEqual({ approved: true, note: 'ok' });
    expect((await store.read('r1')).at(-1)).toMatchObject({
      type: 'ToolApprovalResolved',
      approvalId: 'a1',
      approved: true,
      note: 'ok',
      via: 'cli',
    });
    expect(await inbox.list()).toEqual([]);
    expect(inbox.hasBlocked('a1')).toBe(false);
  });

  it('times out into deferred and keeps the item pending', async () => {
    vi.useFakeTimers();
    const store = new MemoryEventStore();
    await seedRun(store);
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000, newId: () => 'a1' });
    const p = inbox.request(req, {});
    await vi.advanceTimersByTimeAsync(1001);
    expect(await p).toEqual({ deferred: true, approvalId: 'a1' });
    expect(await inbox.list()).toHaveLength(1);
    expect(inbox.hasBlocked('a1')).toBe(false);
  });

  it('an aborted request is deferred too (the item stays pending)', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    const inbox = new InboxService({ store, approvalTimeoutMs: 60_000, newId: () => 'a1' });
    const ac = new AbortController();
    const p = inbox.request(req, { signal: ac.signal });
    await vi.waitFor(async () => expect(await inbox.list()).toHaveLength(1));
    ac.abort();
    expect(await p).toEqual({ deferred: true, approvalId: 'a1' });
    expect(await inbox.list()).toHaveLength(1);
  });

  it('rejects unknown and already resolved ids', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000, newId: () => 'a1' });
    await expect(
      inbox.answer('approval:zz', { approved: true, via: 'api' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    void inbox.request(req, {});
    await vi.waitFor(async () => expect(await inbox.list()).toHaveLength(1));
    await inbox.answer('approval:a1', { approved: false, via: 'telegram' });
    await expect(
      inbox.answer('approval:a1', { approved: true, via: 'cli' }),
    ).rejects.toBeInstanceOf(AlreadyResolvedError);
  });

  it('answering an approval nobody is blocked on (after a restart) only records the event', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    await store.append({
      type: 'ToolApprovalRequested',
      runId: 'r1',
      nodeId: 'impl',
      at: 'x',
      approvalId: 'old',
      role: 'backend',
      tool: 'Bash',
      program: 'git',
      category: 'push',
      command: 'git push',
      argvHash: 'h',
    });
    const resolved: unknown[] = [];
    const inbox = new InboxService({
      store,
      approvalTimeoutMs: 1000,
      onResolved: (item, a) => resolved.push([item.id, a.approved]),
    });
    expect(await inbox.list()).toMatchObject([{ id: 'approval:old' }]);
    await inbox.answer('approval:old', { approved: true, via: 'cli' });
    expect(resolved).toEqual([['approval:old', true]]);
    expect(await inbox.list()).toEqual([]);
  });

  it('lists human nodes and answers them with HumanResponded', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    await store.append({
      type: 'HumanRequested',
      runId: 'r1',
      nodeId: 'ship',
      at: 'x',
      action: 'ship',
      prompt: 'Ship it?',
    });
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000 });
    expect(
      await inbox.ask({ runId: 'r1', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' }),
    ).toEqual({ deferred: true });
    expect(await inbox.list()).toMatchObject([
      { id: 'human:r1:ship', kind: 'human', prompt: 'Ship it?', detail: { action: 'ship' } },
    ]);
    expect(await inbox.answer('human:r1:ship', { approved: true, via: 'cli' })).toEqual({
      runId: 'r1',
      kind: 'human',
    });
    expect((await store.read('r1')).at(-1)).toMatchObject({
      type: 'HumanResponded',
      approved: true,
    });
    expect(await inbox.list()).toEqual([]);
  });

  it('ignores terminal runs when listing', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    await store.append({
      type: 'HumanRequested',
      runId: 'r1',
      nodeId: 'ship',
      at: 'x',
      action: 'ship',
      prompt: '?',
    });
    await store.append({ type: 'RunCancelled', runId: 'r1', at: 'x', reason: 'stop' });
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000 });
    expect(await inbox.list()).toEqual([]);
  });
});
