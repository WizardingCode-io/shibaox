import type { Envelope } from '@shibaox/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/poll.js';
import { AppStore } from '../src/store.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'wf',
    status,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'wf',
    status,
    nodes: {},
    spentUsd: 0.1,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;
const text = (runId: string, t: string, seq = 1): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `0:${seq}`,
    event: { runId, nodeId: 'impl', seq, at: 'x', event: { type: 'text', text: t } },
  }) as unknown as Envelope;
const runFrame = (runId: string, type: string, seq = 1): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { runId, at: 'x', seq, type, nodeId: 'impl' },
  }) as never;

const flush = () => new Promise((r) => setImmediate(r));

let client: FakeDaemonClient;
let store: AppStore;
let poller: Poller;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  client = new FakeDaemonClient();
  store = new AppStore();
  poller = new Poller({ client, store, now: () => Date.now() });
});
afterEach(() => {
  poller.stop();
  vi.useRealTimers();
});

describe('Poller', () => {
  it('tick fills runs and inbox, and a run selection opens its stream', async () => {
    client.runs = [run('a'), run('b')];
    client.states.set('a', state('a'));
    client.inboxItems = [
      {
        id: 'human:a:ship',
        kind: 'human',
        runId: 'a',
        nodeId: 'ship',
        at: 'x',
        prompt: '?',
        detail: {},
      },
    ];
    poller.start();
    await poller.tick();
    await flush();
    expect(store.get().runs).toHaveLength(2);
    expect(store.get().inbox).toHaveLength(1);
    expect(store.get().selectedRunId).toBe('a');
    expect(client.openStreams()).toEqual(['a']);
    client.pushFrame('a', text('a', 'hello'));
    await flush();
    expect(store.get().streams.a?.[0]).toMatchObject({ text: 'hello' });
    client.pushFrame('a', runFrame('a', 'NodeCompleted', 2));
    await flush();
    expect(client.calls.filter((c) => c.method === 'getRun')).toHaveLength(1);
    expect(store.get().runStates.a).toBeDefined();
  });

  it('switching runs quickly keeps a single subscription', async () => {
    client.runs = [run('a'), run('b'), run('c')];
    for (const id of ['a', 'b', 'c']) client.states.set(id, state(id));
    poller.start();
    await poller.tick();
    await flush();
    store.select('a');
    store.select('b');
    store.select('c');
    await flush();
    expect(client.openStreams()).toEqual(['c']);
    client.pushFrame('a', text('a', 'stale'));
    client.pushFrame('c', text('c', 'fresh'));
    await flush();
    expect(store.get().streams.a ?? []).toEqual([]);
    expect(store.get().streams.c?.[0]).toMatchObject({ text: 'fresh' });
  });

  it('recovers after the daemon comes back and reopens the stream', async () => {
    client.runs = [run('a')];
    client.states.set('a', state('a'));
    poller.start();
    await poller.tick();
    await flush();
    expect(client.openStreams()).toEqual(['a']);
    client.failing = true;
    await poller.tick();
    await flush();
    expect(store.get().daemonReachable).toBe(false);
    expect(store.get().actionsEnabled).toBe(false);
    expect(client.openStreams()).toEqual([]);
    // the next scheduled tick waits the slow interval
    const before = client.calls.length;
    await vi.advanceTimersByTimeAsync(1100);
    expect(client.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(4000);
    expect(client.calls.length).toBeGreaterThan(before);
    client.failing = false;
    await poller.tick();
    await flush();
    expect(store.get().daemonReachable).toBe(true);
    expect(client.openStreams()).toEqual(['a']);
  });

  it('answer maps a 409 to "Already answered elsewhere" and success to a toast', async () => {
    client.inboxItems = [
      {
        id: 'human:a:ship',
        kind: 'human',
        runId: 'a',
        nodeId: 'ship',
        at: 'x',
        prompt: '?',
        detail: {},
      },
    ];
    await poller.answer('human:a:ship', true, 'go');
    expect(client.calls.find((c) => c.method === 'answer')?.args).toEqual([
      'human:a:ship',
      { approved: true, note: 'go', via: 'cli' },
    ]);
    expect(store.get().toast).toMatchObject({ text: 'Approved', tone: 'success' });
    client.answerError = { status: 409, code: 'already_resolved', message: 'was already answered' };
    await poller.answer('human:a:ship', false);
    expect(store.get().toast).toMatchObject({ text: 'Already answered elsewhere', tone: 'info' });
    client.answerError = { status: 400, code: 'bad_request', message: 'nope' };
    await poller.answer('human:a:ship', false);
    expect(store.get().toast).toMatchObject({ text: 'nope', tone: 'danger' });
  });

  it('submit selects the new run; cancel and resume show toasts', async () => {
    client.submitResult = { runId: 'n1', warnings: ['careful'] };
    client.states.set('n1', state('n1', 'queued'));
    expect(await poller.submit({ orgRoot: '/o', project: '/p', workflow: 'wf', input: 'x' })).toBe(
      'n1',
    );
    expect(store.get().selectedRunId).toBe('n1');
    expect(store.get().toast).toMatchObject({ text: 'Run n1 queued (careful)', tone: 'success' });
    await poller.cancel('n1');
    expect(store.get().toast).toMatchObject({ text: 'Run n1 cancelled' });
    await poller.resume('n1', 3);
    expect(client.calls.find((c) => c.method === 'resume')?.args).toEqual(['n1', { budgetUsd: 3 }]);
  });

  it('actions after an action poll fast for three seconds, then normally', async () => {
    poller.start();
    const count = () => client.calls.filter((c) => c.method === 'listRuns').length;
    await vi.advanceTimersByTimeAsync(1000);
    const base = count();
    await poller.answer('human:a:ship', true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(count() - base).toBeGreaterThanOrEqual(2);
  });

  it('stop closes the stream and leaves no timers', async () => {
    client.runs = [run('a')];
    client.states.set('a', state('a'));
    poller.start();
    await poller.tick();
    await flush();
    expect(client.openStreams()).toEqual(['a']);
    poller.stop();
    await flush();
    expect(client.openStreams()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
