import type { InboxItem } from '@shibaox/daemon';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from '../src/poll.js';
import { Dashboard } from '../src/screens/Dashboard.js';
import { AppStore } from '../src/store.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    nodes: {},
    spentUsd: 0.1,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;
const item = (id: string, runId: string, kind: 'human' | 'approval' = 'human'): InboxItem => ({
  id,
  kind,
  runId,
  nodeId: 'ship',
  at: '2026-09-26T10:00:00.000Z',
  prompt: kind === 'human' ? 'Approve the push?' : 'git push origin main',
  detail:
    kind === 'human' ? { action: 'ship' } : { role: 'backend', program: 'git', category: 'push' },
});

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

let client: FakeDaemonClient;
let store: AppStore;
let poller: Poller;
let exitCode: number | undefined;
const mount = (env: NodeJS.ProcessEnv = { SHIBAOX_NO_MOTION: '1' }) =>
  render(
    <Dashboard
      store={store}
      poller={poller}
      version="0.0.1"
      env={env}
      size={{ columns: 120, rows: 30 }}
      onExit={(code) => {
        exitCode = code;
      }}
    />,
  );

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  client = new FakeDaemonClient();
  client.runs = [run('aaaa1111-x'), run('bbbb2222-x', 'waiting_human')];
  for (const r of client.runs) client.states.set(r.runId, state(r.runId, r.status));
  client.inboxItems = [item('human:bbbb2222-x:ship', 'bbbb2222-x')];
  store = new AppStore();
  poller = new Poller({ client, store });
  poller.start();
  await poller.tick();
  await flush();
  exitCode = undefined;
});
afterEach(() => {
  poller.stop();
  vi.useRealTimers();
});

describe('Dashboard', () => {
  it('lists runs with status words and follows the selection with j/k', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    expect(lastFrame()).toContain('● Working');
    expect(lastFrame()).toContain('● Needs you');
    expect(store.get().selectedRunId).toBe('aaaa1111-x');
    stdin.write('j');
    await flush();
    expect(store.get().selectedRunId).toBe('bbbb2222-x');
    expect(client.openStreams()).toEqual(['bbbb2222-x']);
    stdin.write('\r');
    await flush();
    expect(store.get().focus).toBe('detail');
    unmount();
  });

  it('the inbox banner shows the oldest item and a/d answer it', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    expect(lastFrame()).toContain('▲ Needs you (1)');
    expect(lastFrame()).toContain('Approve the push?');
    stdin.write('a');
    await flush();
    expect(client.calls.find((c) => c.method === 'answer')?.args).toEqual([
      'human:bbbb2222-x:ship',
      { approved: true, note: undefined, via: 'cli' },
    ]);
    stdin.write('d');
    await flush();
    expect(client.calls.filter((c) => c.method === 'answer').at(-1)?.args[1]).toMatchObject({
      approved: false,
    });
    unmount();
  });

  it('n asks for a note and answers with it', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    stdin.write('n');
    await flush();
    expect(lastFrame()).toContain('Note');
    stdin.write('ship it');
    await flush();
    stdin.write('\r');
    await flush();
    expect(client.calls.find((c) => c.method === 'answer')?.args[1]).toEqual({
      approved: true,
      note: 'ship it',
      via: 'cli',
    });
    unmount();
  });

  it('a 409 shows a toast and the banner moves on', async () => {
    client.inboxItems = [
      item('human:bbbb2222-x:ship', 'bbbb2222-x'),
      item('approval:a2', 'aaaa1111-x', 'approval'),
    ];
    await poller.tick();
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    expect(lastFrame()).toContain('▲ Needs you (2)');
    client.answerError = { status: 409, code: 'already_resolved', message: 'was already answered' };
    stdin.write('a');
    await flush();
    expect(lastFrame()).toContain('Already answered elsewhere');
    client.answerError = undefined;
    client.inboxItems = [item('approval:a2', 'aaaa1111-x', 'approval')];
    await poller.tick();
    await flush();
    expect(lastFrame()).toContain('▲ Needs you (1)');
    expect(lastFrame()).toContain('git push origin main');
    unmount();
  });

  it('c asks for confirmation before cancelling', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    stdin.write('c');
    await flush();
    expect(lastFrame()).toContain('Cancel run aaaa1111?');
    stdin.write('y');
    await flush();
    expect(client.calls.find((c) => c.method === 'cancel')?.args).toEqual(['aaaa1111-x']);
    unmount();
  });

  it('q exits and leaves no timers after unmount', async () => {
    const { stdin, unmount } = mount();
    await flush();
    stdin.write('q');
    await flush();
    expect(exitCode).toBe(0);
    unmount();
    poller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('action keys do nothing but a toast while the daemon is unreachable', async () => {
    client.failing = true;
    await poller.tick();
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    expect(lastFrame()).toContain('Daemon unreachable');
    const before = client.calls.filter((c) => c.method === 'answer').length;
    stdin.write('a');
    await flush();
    expect(client.calls.filter((c) => c.method === 'answer')).toHaveLength(before);
    expect(lastFrame()).toContain('Daemon unreachable');
    unmount();
  });

  it('a small terminal only shows the size notice', async () => {
    const { lastFrame, unmount } = render(
      <Dashboard
        store={store}
        poller={poller}
        version="0.0.1"
        env={{}}
        size={{ columns: 50, rows: 10 }}
        onExit={() => {}}
      />,
    );
    await flush();
    expect(lastFrame()).toBe('Terminal too small (need 60×15)');
    unmount();
  });

  it('? opens the help and f toggles the filter', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await flush();
    stdin.write('?');
    await flush();
    expect(lastFrame()).toContain('j/k select');
    stdin.write('q'); // q closes the help too (a lone ESC is buffered by the terminal parser)
    await flush();
    expect(store.get().view).toBe('dashboard');
    stdin.write('f');
    await flush();
    expect(store.get().filter).toBe('all');
    unmount();
  });
});
