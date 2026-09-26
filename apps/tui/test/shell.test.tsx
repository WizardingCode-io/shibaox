import { expect, test } from 'bun:test';
import { createTestRenderer } from '@opentui/core/testing';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { App, type AppHooks, runStream } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: '2026-09-26T10:00:00Z',
    updatedAt: '2026-09-26T10:00:00Z',
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status = 'running'): RunState =>
  ({
    runId,
    workflow: 'hello-feature',
    input: {},
    workspace: '/w',
    status,
    nodes: {},
    spentUsd: 0.1,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as RunState;
const end = (status: string): Envelope =>
  ({ kind: 'end', seq: 9, cursor: '9:0', status }) as unknown as Envelope;

async function mount(o: { width?: number; height?: number; open?: string[] } = {}) {
  const client = new FakeDaemonClient();
  client.runs = [run('aaaa1111-x'), run('bbbb2222-x')];
  for (const r of client.runs as { runId: string }[]) client.states.set(r.runId, state(r.runId));
  const exits: number[] = [];
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home="/tmp/shx-home"
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={(c) => exits.push(c)}
        onMount={(h) => {
          hooks = h;
          for (const id of o.open ?? []) h.data.openRun(id);
        }}
      />
    ),
    { width: o.width ?? 160, height: o.height ?? 30, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const ctrl = async (k: string) => {
    await setup.mockInput.pressKey(k, { ctrl: true });
    return frame();
  };
  if (!hooks) throw new Error('hooks missing');
  return { client, setup, frame, ctrl, exits, hooks, done: () => setup.renderer.destroy() };
}

test('tabs: one line on top with home and every open run, at any width', async () => {
  const m = await mount({ open: ['aaaa1111-x', 'bbbb2222-x'] });
  try {
    let f = await m.frame();
    const row = f.split('\n').find((l) => l.includes('⌂')) ?? '';
    expect(row).toContain('aaaa1111 hello-feature');
    expect(row).toContain('bbbb2222 hello-feature');
    expect(m.hooks.data.state.active).toBe('bbbb2222-x');
    m.setup.resize(100, 30);
    f = await m.frame();
    expect(f.split('\n').filter((l) => l.includes('⌂'))).toHaveLength(1);
    m.hooks.data.closeRun('aaaa1111-x');
    m.hooks.data.closeRun('bbbb2222-x');
    f = await m.frame();
    expect(f).not.toContain('⌂'); // no runs open: no tabs line on the home
  } finally {
    m.done();
  }
});

test('ctrl+] and ctrl+p cycle tabs, ctrl+w closes the active one, ctrl+n goes home', async () => {
  const m = await mount({ open: ['aaaa1111-x', 'bbbb2222-x'] });
  try {
    await m.frame();
    await m.ctrl(']');
    expect(m.hooks.data.state.active).toBeUndefined(); // home comes after the last tab
    await m.ctrl(']');
    expect(m.hooks.data.state.active).toBe('aaaa1111-x');
    await m.ctrl('p');
    expect(m.hooks.data.state.active).toBeUndefined();
    await m.ctrl('p');
    expect(m.hooks.data.state.active).toBe('bbbb2222-x');
    await m.ctrl('w');
    expect(m.hooks.data.state.open).toEqual(['aaaa1111-x']);
    expect(m.hooks.data.state.active).toBe('aaaa1111-x');
    const f = await m.ctrl('n');
    expect(m.hooks.data.state.active).toBeUndefined();
    expect(f).toContain('Add a /health endpoint');
  } finally {
    m.done();
  }
});

test('closing a tab releases its frames and timeline', async () => {
  const m = await mount({ open: ['aaaa1111-x', 'bbbb2222-x'] });
  try {
    await m.frame();
    expect(m.hooks.data.frameCount('aaaa1111-x')).toBe(0);
    const t = m.hooks.data.timeline('aaaa1111-x');
    m.hooks.data.closeRun('aaaa1111-x');
    await m.frame();
    expect(m.hooks.data.frameCount('aaaa1111-x')).toBeUndefined();
    expect(m.hooks.data.timeline('aaaa1111-x')).not.toBe(t);
    expect(m.client.openStreams()).toEqual(['bbbb2222-x']);
  } finally {
    m.done();
  }
});

test('a background run that ends marks its tab until it is opened; clicking a tab activates it', async () => {
  const m = await mount({ open: ['aaaa1111-x', 'bbbb2222-x'] });
  try {
    await m.frame();
    m.client.states.set('aaaa1111-x', state('aaaa1111-x', 'completed'));
    m.client.pushFrame('aaaa1111-x', end('completed'));
    let f = await m.frame();
    expect(m.hooks.data.state.unread['aaaa1111-x']).toBe('done');
    const isTab = (l: string) => l.includes('aaaa1111') && !l.includes('is done');
    const row = f.split('\n').find(isTab) ?? '';
    expect(row).toContain('•');
    const y = f.split('\n').findIndex(isTab);
    await m.setup.mockMouse.click(row.indexOf('aaaa1111') + 2, y);
    f = await m.frame();
    expect(m.hooks.data.state.active).toBe('aaaa1111-x');
    expect(m.hooks.data.state.unread['aaaa1111-x']).toBeUndefined();
    expect(f.split('\n').find(isTab)).not.toContain('•');
  } finally {
    m.done();
  }
});

test('the reconnecting overlay covers the page after 2 s; a tiny terminal shows the notice', async () => {
  const m = await mount({ open: ['aaaa1111-x'] });
  try {
    await m.frame();
    m.client.failing = true;
    await settle(1200);
    await m.frame();
    expect(m.setup.captureCharFrame()).not.toContain('Connection lost');
    await settle(1600);
    let f = await m.frame();
    expect(f).toContain('Connection lost');
    m.client.failing = false;
    await settle(5200);
    f = await m.frame();
    expect(f).not.toContain('Connection lost');
    m.setup.resize(50, 10);
    f = await m.frame();
    expect(f).toContain('Terminal too small');
  } finally {
    m.done();
  }
}, 20_000);

test('runStream ends with the run: 0 on completed, 2 on failed, and says it keeps running on abort', async () => {
  const client = new FakeDaemonClient();
  client.runs = [run('r1')];
  client.states.set('r1', state('r1'));
  const base = { version: '0.0.1', home: '/tmp/shx-home', env: { SHIBAOX_NO_MOTION: '1' } };
  let setup = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false });
  try {
    const done = runStream(client, 'r1', { ...base, renderer: setup.renderer });
    await settle(80);
    client.states.set('r1', state('r1', 'completed'));
    client.pushFrame('r1', end('completed'));
    expect(await done).toEqual({ code: 0 });
  } finally {
    setup.renderer.destroy();
  }
  client.runs = [run('r2')];
  client.states.set('r2', state('r2'));
  setup = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false });
  try {
    const done = runStream(client, 'r2', { ...base, renderer: setup.renderer });
    await settle(80);
    client.states.set('r2', state('r2', 'failed'));
    client.pushFrame('r2', end('failed'));
    expect(await done).toEqual({ code: 2 });
  } finally {
    setup.renderer.destroy();
  }
  client.runs = [run('r3')];
  client.states.set('r3', state('r3'));
  setup = await createTestRenderer({ width: 100, height: 24, exitOnCtrlC: false });
  try {
    const ac = new AbortController();
    const done = runStream(client, 'r3', { ...base, renderer: setup.renderer, signal: ac.signal });
    await settle(80);
    ac.abort();
    const r = await done;
    expect(r.code).toBe(0);
    expect(r.message).toContain('keeps running');
  } finally {
    setup.renderer.destroy();
  }
});
