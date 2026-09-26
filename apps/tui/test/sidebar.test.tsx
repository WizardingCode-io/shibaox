import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope, InboxItem } from '@shibaox/daemon';
import { App, type AppHooks } from '../src/app.js';
import { loadPrefs } from '../src/context/prefs.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString();
const yesterday = new Date(Date.now() - 26 * 3600_000).toISOString();
const run = (runId: string, status: string, createdAt: string) =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt,
    updatedAt: createdAt,
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status: string): RunState =>
  ({
    runId,
    workflow: 'hello-feature',
    workflowSnapshot: {
      workflow: 'hello-feature',
      start: 'analyse',
      nodes: { analyse: { type: 'task', role: 'analyst' } },
    },
    input: {},
    workspace: '/w',
    status,
    nodes: { analyse: { status: 'completed', attempts: 1, approvals: {} } },
    spentUsd: 0.1,
    budgetWarned: false,
    pendingHumans:
      status === 'waiting_human' ? [{ nodeId: 'ship', action: 'ship', prompt: 'Ship?' }] : [],
    pendingApprovals: [],
  }) as RunState;
const approval: InboxItem = {
  id: 'approval:a9' as never,
  kind: 'approval',
  runId: 'aaaa1111-x',
  nodeId: 'implement',
  at: today,
  prompt: 'git push origin main',
  detail: { role: 'backend', program: 'git', category: 'push' },
};
const human: InboxItem = {
  id: 'human:bbbb2222-x:ship' as never,
  kind: 'human',
  runId: 'bbbb2222-x',
  nodeId: 'ship',
  at: today,
  prompt: 'Ship?',
  detail: { action: 'ship' },
};
const rt = (nodeId: string, seq: number, event: Record<string, unknown>): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `0:${seq}`,
    event: { runId: 'aaaa1111-x', nodeId, seq, at: 'x', event },
  }) as unknown as Envelope;

async function mount(o: { width?: number; height?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-sidebar-'));
  const client = new FakeDaemonClient();
  client.runs = [
    run('aaaa1111-x', 'running', today),
    run('bbbb2222-x', 'waiting_human', yesterday),
  ];
  client.states.set('aaaa1111-x', state('aaaa1111-x', 'running'));
  client.states.set('bbbb2222-x', state('bbbb2222-x', 'waiting_human'));
  client.inboxItems = [human];
  client.history.set('aaaa1111-x', [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId: 'aaaa1111-x', at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'analyse' },
    } as unknown as Envelope,
    rt('analyse', 2, { type: 'file_changed', path: 'src/a.ts' }),
    rt('analyse', 3, { type: 'file_changed', path: 'src/b.ts' }),
    {
      kind: 'run',
      seq: 4,
      cursor: '4:0',
      event: {
        runId: 'aaaa1111-x',
        at: 'x',
        seq: 4,
        type: 'NodeCompleted',
        nodeId: 'analyse',
        output: {},
        summary: '',
        cost: { usd: 0.1 },
      },
    } as unknown as Envelope,
  ]);
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={dir}
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
        onMount={(h) => {
          hooks = h;
          h.data.openRun('aaaa1111-x');
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
  const key = async (k: string, mods?: { ctrl?: boolean }) => {
    if (k === 'return') await setup.mockInput.pressEnter();
    else if (k === 'tab') await setup.mockInput.pressTab();
    else await setup.mockInput.pressKey(k, mods);
    return frame();
  };
  if (!hooks) throw new Error('hooks missing');
  return {
    dir,
    client,
    setup,
    frame,
    key,
    hooks,
    done: () => {
      setup.renderer.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('the sidebar lists runs by day, the inbox and this run, on wide terminals only', async () => {
  const m = await mount();
  try {
    let f = await m.frame();
    expect(f).toContain('Runs');
    expect(f).toContain('Today');
    expect(f).toContain('Yesterday');
    expect(f).toContain('bbbb2222');
    expect(f).toContain('Needs you (1)');
    expect(f).toContain('This run');
    expect(f).toContain('src/a.ts');
    expect(f).toContain('analyse $0.1000');
    m.setup.resize(120, 30);
    f = await m.frame();
    expect(f).not.toContain('Needs you (1)');
    f = await m.key('b', { ctrl: true });
    expect(f).toContain('Needs you (1)');
    expect(loadPrefs(m.dir).sidebar).toBe('auto');
    f = await m.key('b', { ctrl: true });
    expect(f).not.toContain('Needs you (1)');
    expect(loadPrefs(m.dir).sidebar).toBe('hide');
  } finally {
    m.done();
  }
});

test('tab focuses the sidebar: j/k select a run, enter opens it, a answers its pending item', async () => {
  const m = await mount();
  try {
    await m.frame();
    let f = await m.key('tab');
    f = await m.key('j');
    f = await m.key('return');
    expect(m.hooks.data.state.active).toBe('bbbb2222-x');
    expect(m.hooks.data.state.open).toEqual(['aaaa1111-x', 'bbbb2222-x']);
    await m.key('a');
    expect(m.client.calls.find((c) => c.method === 'answer')?.args[0]).toBe(
      'human:bbbb2222-x:ship',
    );
    f = await m.key('tab');
    expect(f).toContain('Runs');
  } finally {
    m.done();
  }
});

test('Needs-you items are selectable: a on a command approval asks y first; a on a run with nothing waiting says so', async () => {
  const m = await mount();
  try {
    m.client.inboxItems = [human, approval];
    await settle(1100);
    await m.frame();
    await m.key('tab');
    // rows: Today aaaa1111, Yesterday bbbb2222, then the two Needs-you items
    let f = await m.key('j');
    f = await m.key('j');
    f = await m.key('j');
    f = await m.key('a');
    expect(f).toContain('Approve git push origin main? (y/n)');
    expect(m.client.calls.filter((c) => c.method === 'answer')).toHaveLength(0);
    await m.key('y');
    expect(m.client.calls.find((c) => c.method === 'answer')?.args[0]).toBe('approval:a9');
    m.client.inboxItems = [];
    await settle(1100);
    await m.frame();
    await m.key('k');
    await m.key('k');
    await m.key('k');
    f = await m.key('a');
    // the "Approved" toast may still be up: the notice then queues behind it
    expect(f.includes('Nothing waiting') || f.includes('+1 more')).toBe(true);
    expect(m.client.calls.filter((c) => c.method === 'answer')).toHaveLength(1);
  } finally {
    m.done();
  }
});

test('dragging the handle resizes the sidebar and remembers the width', async () => {
  const m = await mount();
  try {
    const f = await m.frame();
    const row = f.split('\n').findIndex((l) => l.includes('Needs you (1)'));
    const x = 160 - 42 - 1;
    await m.setup.mockMouse.drag(x, row, x - 17, row);
    await m.frame();
    expect(loadPrefs(m.dir).sidebarWidth).toBe(59);
  } finally {
    m.done();
  }
});

test('resizing from 160 to 80 columns collapses rail and sidebar without overflow', async () => {
  const m = await mount();
  try {
    await m.frame();
    m.setup.resize(80, 24);
    const f = await m.frame();
    expect(f).not.toContain('Needs you (1)');
    expect(f.split('\n').filter((l) => l.includes('⌂'))).toHaveLength(1);
    for (const line of f.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(f.split('\n').at(-2)).toContain('enter expand');
  } finally {
    m.done();
  }
});
