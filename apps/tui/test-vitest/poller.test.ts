import type { Envelope } from '@shibaox/daemon';
import { createStore } from 'solid-js/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DataState, initialData } from '../src/context/data-state.js';
import { Poller } from '../src/context/poller.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: 'x',
    updatedAt: 'x',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running', pending: string[] = []) =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    nodes: {},
    spentUsd: 0.1,
    pendingHumans: pending.map((nodeId) => ({ nodeId, action: 'ship', prompt: 'Ship?' })),
    pendingApprovals: [],
  }) as never;
const frame = (runId: string, seq: number, event: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { runId, at: 'x', seq, ...event },
  }) as unknown as Envelope;
const end = (seq: number, status = 'completed'): Envelope =>
  ({ kind: 'end', seq, cursor: `${seq}:0`, status }) as unknown as Envelope;
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
  const client = new FakeDaemonClient();
  client.runs = [run('a'), run('b'), run('c')];
  for (const r of client.runs) client.states.set(r.runId, state(r.runId));
  client.inboxItems = [];
  const [data, set] = createStore<DataState>(initialData());
  const toasts: {
    message: string;
    variant: string;
    action?: { label: string; run: () => void };
  }[] = [];
  const now = { t: 1_000_000 };
  const poller = new Poller({
    client,
    set,
    get: () => data,
    toast: (t) => toasts.push(t),
    now: () => now.t,
  });
  return { client, data, set, poller, toasts, now };
}

describe('Poller', () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }),
  );
  afterEach(() => vi.useRealTimers());

  it('tick fills runs and inbox and marks the daemon reachable', async () => {
    const s = setup();
    s.client.inboxItems = [
      {
        id: 'h1',
        kind: 'human',
        runId: 'a',
        nodeId: 'ship',
        at: 'x',
        prompt: 'Ship?',
        detail: {},
      } as never,
    ];
    await s.poller.tick();
    expect(s.data.runs).toHaveLength(3);
    expect(s.data.inbox).toHaveLength(1);
    expect(s.data.reachable).toBe(true);
  });

  it('a failing daemon flips reachable, records since and slows the polling', async () => {
    const s = setup();
    s.poller.start();
    await s.poller.tick();
    s.client.failing = true;
    await s.poller.tick();
    expect(s.data.reachable).toBe(false);
    expect(s.data.unreachableSince).toBe(s.now.t);
    const before = s.client.calls.filter((c) => c.method === 'listRuns').length;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(s.client.calls.filter((c) => c.method === 'listRuns').length).toBe(before);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.client.calls.filter((c) => c.method === 'listRuns').length).toBe(before + 1);
    s.poller.stop();
  });

  it('keeps one stream per subscribed run and routes frames to the right run', async () => {
    const s = setup();
    s.poller.start();
    await s.poller.tick();
    s.poller.subscribe('a');
    s.poller.subscribe('b');
    await flush();
    expect(s.client.openStreams().sort()).toEqual(['a', 'b']);
    s.client.pushFrame('a', frame('a', 1, { type: 'NodeStarted', nodeId: 'x' }));
    s.client.pushFrame('b', frame('b', 1, { type: 'NodeStarted', nodeId: 'y' }));
    await flush();
    expect(s.data.frames.a?.map((f) => f.seq)).toEqual([1]);
    expect(s.data.frames.b?.map((f) => f.seq)).toEqual([1]);
    s.poller.unsubscribe('a');
    await flush();
    expect(s.client.openStreams()).toEqual(['b']);
    s.poller.stop();
    await flush();
    expect(s.client.openStreams()).toEqual([]);
  });

  it('reopens every tab stream with its cursor after the daemon returns', async () => {
    const s = setup();
    s.poller.start();
    await s.poller.tick();
    for (const id of ['a', 'b', 'c']) s.poller.subscribe(id);
    await flush();
    s.client.pushFrame('a', frame('a', 7, { type: 'NodeStarted', nodeId: 'x' }));
    s.client.pushFrame('c', frame('c', 3, { type: 'NodeStarted', nodeId: 'x' }));
    await flush();
    s.client.failing = true;
    await s.poller.tick();
    await flush();
    expect(s.client.openStreams()).toEqual([]);
    s.client.failing = false;
    await s.poller.tick();
    await flush();
    expect(s.client.openStreams().sort()).toEqual(['a', 'b', 'c']);
    const reopened = s.client.calls.filter((c) => c.method === 'events').slice(-3);
    const since = Object.fromEntries(
      reopened.map((c) => [c.args[0], (c.args[1] as { since?: string }).since]),
    );
    expect(since).toEqual({ a: '7:0', b: undefined, c: '3:0' });
    s.poller.stop();
  });

  it('an ending run that is not active becomes unread and toasts with an Open action', async () => {
    const s = setup();
    s.poller.start();
    await s.poller.tick();
    s.set('active', 'b');
    s.poller.subscribe('a');
    await flush();
    s.client.states.set('a', state('a', 'completed'));
    s.client.pushFrame('a', end(9));
    await flush();
    expect(s.data.ended.a).toBe('completed');
    expect(s.data.unread.a).toBe('done');
    expect(s.toasts.at(-1)).toMatchObject({
      message: 'Run a is done',
      variant: 'success',
      action: { label: 'Open' },
    });
    s.poller.stop();
  });

  it('a run that starts waiting while not active becomes unread as needs', async () => {
    const s = setup();
    s.poller.start();
    await s.poller.tick();
    s.set('active', 'b');
    s.poller.subscribe('a');
    await flush();
    s.client.states.set('a', state('a', 'waiting_human', ['ship']));
    s.client.pushFrame(
      'a',
      frame('a', 2, { type: 'HumanRequested', nodeId: 'ship', action: 'ship', prompt: 'Ship?' }),
    );
    await flush();
    await vi.advanceTimersByTimeAsync(250); // state refreshes are throttled to 200 ms
    await flush();
    expect(s.data.unread.a).toBe('needs');
    s.poller.stop();
  });

  it('answer reports 409 as already answered and other errors as errors', async () => {
    const s = setup();
    s.client.answerError = {
      status: 409,
      code: 'already_resolved',
      message: 'was already answered',
    };
    await s.poller.answer('h1' as never, true);
    expect(s.toasts.at(-1)).toMatchObject({
      message: 'Already answered elsewhere',
      variant: 'info',
    });
    s.client.answerError = undefined;
    await s.poller.answer('h1' as never, false, 'no');
    expect(s.client.calls.at(-1)?.args).toEqual([
      'h1',
      { approved: false, note: 'no', via: 'cli' },
    ]);
    expect(s.toasts.at(-1)).toMatchObject({ message: 'Denied', variant: 'success' });
  });

  it('submit returns the run id and stop leaves no timers', async () => {
    const s = setup();
    s.poller.start();
    expect(await s.poller.submit({ orgRoot: '/o', project: '/p', workflow: 'w', input: 'x' })).toBe(
      'new-run',
    );
    s.poller.stop();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });
});
