import { describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/react/test-utils';
import type { InboxItem } from '@shibaox/daemon';
import { Poller } from '../src/poll.js';
import { AppStore } from '../src/store.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';
import { Dashboard } from '../src/ui/Dashboard.js';

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
    nodes: { analyse: { status: 'completed', attempts: 1, approvals: {} } },
    workflowSnapshot: {
      workflow: 'hello-feature',
      start: 'analyse',
      nodes: { analyse: { type: 'task', role: 'analyst' } },
    },
    spentUsd: 0.1,
    pendingHumans: [],
    pendingApprovals: [],
  }) as never;
const item = (id: string, runId: string, kind: 'human' | 'approval' = 'human'): InboxItem => ({
  id: id as InboxItem['id'],
  kind,
  runId,
  nodeId: 'ship',
  at: '2026-09-26T10:00:00.000Z',
  prompt: kind === 'human' ? 'Approve the push?' : 'git push origin main',
  detail:
    kind === 'human' ? { action: 'ship' } : { role: 'backend', program: 'git', category: 'push' },
});

async function mount(
  o: {
    inbox?: InboxItem[];
    width?: number;
    height?: number;
    failing?: boolean;
    runs?: number;
  } = {},
) {
  const client = new FakeDaemonClient();
  client.runs = o.runs
    ? Array.from({ length: o.runs }, (_, i) => run(`run${String(i).padStart(4, '0')}-x`))
    : [run('aaaa1111-x'), run('bbbb2222-x', 'waiting_human')];
  for (const r of client.runs) client.states.set(r.runId, state(r.runId, r.status));
  client.inboxItems = o.inbox ?? [item('human:bbbb2222-x:ship', 'bbbb2222-x')];
  client.failing = o.failing ?? false;
  const store = new AppStore();
  const poller = new Poller({ client, store });
  poller.start();
  await poller.tick();
  const exits: number[] = [];
  const setup = await testRender(
    <Dashboard
      store={store}
      poller={poller}
      version="0.0.1"
      env={{ SHIBAOX_NO_MOTION: '1' }}
      cwd="/tmp"
      home="/tmp/shx-home"
      onExit={(c) => exits.push(c)}
    />,
    { width: o.width ?? 120, height: o.height ?? 30 },
  );
  const frame = async () => {
    await setup.renderOnce();
    await setup.waitForVisualIdle().catch(() => {});
    return setup.captureCharFrame();
  };
  const key = async (k: string) => {
    if (k === 'return') await setup.mockInput.pressEnter();
    else if (k === 'escape') await setup.mockInput.pressEscape();
    else if (k === 'tab') await setup.mockInput.pressTab();
    else await setup.mockInput.typeText(k);
    return frame();
  };
  const done = () => {
    poller.stop();
    setup.renderer.destroy();
  };
  return { client, store, poller, setup, frame, key, exits, done };
}

describe('Dashboard (OpenTUI)', () => {
  test('draws the mock layout: title panel, banner, runs and detail panels, footer', async () => {
    const m = await mount();
    try {
      const f = await m.frame();
      expect(f).toContain('shibaox · daemon 0.0.1');
      expect(f).toContain('▲ Needs you (1)');
      expect(f).toContain('Approve the push?');
      expect(f).toContain('Runs');
      expect(f).toContain('▸ aaaa1111 hello-feature');
      expect(f).toContain('● Working');
      expect(f).toContain('● Needs you');
      expect(f).toContain('analyse');
      expect(f).toContain('j/k select');
      expect(f).toContain('╭');
    } finally {
      m.done();
    }
  });

  test('j/k move the selection and enter focuses the detail', async () => {
    const m = await mount();
    try {
      await m.key('j');
      expect(m.store.get().selectedRunId).toBe('bbbb2222-x');
      expect(m.client.openStreams()).toEqual(['bbbb2222-x']);
      await m.key('return');
      expect(m.store.get().focus).toBe('detail');
      await m.key('tab');
      expect(m.store.get().focus).toBe('list');
    } finally {
      m.done();
    }
  });

  test('a answers a human item; an approval item asks y first', async () => {
    const m = await mount({
      inbox: [
        item('human:bbbb2222-x:ship', 'bbbb2222-x'),
        item('approval:a2', 'aaaa1111-x', 'approval'),
      ],
    });
    try {
      await m.key('a');
      expect(m.client.calls.find((c) => c.method === 'answer')?.args).toEqual([
        'human:bbbb2222-x:ship',
        { approved: true, note: undefined, via: 'cli' },
      ]);
      m.client.inboxItems = [item('approval:a2', 'aaaa1111-x', 'approval')];
      await m.poller.tick();
      const f = await m.key('a');
      expect(f).toContain('Approve git push origin main?');
      expect(m.client.calls.filter((c) => c.method === 'answer')).toHaveLength(1);
      await m.key('y');
      expect(m.client.calls.filter((c) => c.method === 'answer').at(-1)?.args[0]).toBe(
        'approval:a2',
      );
    } finally {
      m.done();
    }
  });

  test('a 409 shows a toast and the banner moves on', async () => {
    const m = await mount({
      inbox: [
        item('human:bbbb2222-x:ship', 'bbbb2222-x'),
        item('approval:a2', 'aaaa1111-x', 'approval'),
      ],
    });
    try {
      m.client.answerError = {
        status: 409,
        code: 'already_resolved',
        message: 'was already answered',
      };
      let f = await m.key('a');
      expect(f).toContain('Already answered elsewhere');
      m.client.answerError = undefined;
      m.client.inboxItems = [item('approval:a2', 'aaaa1111-x', 'approval')];
      await m.poller.tick();
      f = await m.frame();
      expect(f).toContain('▲ Needs you (1)');
      expect(f).toContain('git push origin main');
    } finally {
      m.done();
    }
  });

  test('c confirms before cancelling; q exits', async () => {
    const m = await mount();
    try {
      const f = await m.key('c');
      expect(f).toContain('Cancel run aaaa1111?');
      await m.key('y');
      expect(m.client.calls.find((c) => c.method === 'cancel')?.args).toEqual(['aaaa1111-x']);
      await m.key('q');
      expect(m.exits).toEqual([0]);
    } finally {
      m.done();
    }
  });

  test('Ctrl-C exits from the dashboard, from help, from a prompt and from the form', async () => {
    for (const open of [[], ['?'], ['c'], ['N']]) {
      const m = await mount({ inbox: [] });
      try {
        for (const k of open) await m.key(k);
        await m.setup.mockInput.pressKey('\x03');
        await m.frame();
        expect(m.exits).toEqual([0]);
      } finally {
        m.done();
      }
    }
  });

  test('the runs list scrolls to keep the selection visible and never overflows its panel', async () => {
    const m = await mount({ runs: 20, inbox: [], width: 120, height: 30 });
    try {
      let f = await m.frame();
      expect(f).toContain('▸ run0000');
      for (let i = 0; i < 15; i++) f = await m.key('j');
      expect(m.store.get().selectedRunId).toBe('run0015-x');
      expect(f).toContain('▸ run0015');
      expect(f).toContain('j/k select');
      // no run text on the panel's bottom border row
      const border = f.split('\n').find((l) => l.startsWith('╰')) ?? '';
      expect(border).not.toContain('run00');
    } finally {
      m.done();
    }
  });

  test('titles use the status word, and the banner keeps its keys at 80 columns', async () => {
    const m = await mount({ width: 80 });
    try {
      const f = await m.frame();
      expect(f).toContain('[a]pprove');
      expect(f).not.toContain('waiting_human');
    } finally {
      m.done();
    }
  });

  test('action keys only toast while the daemon is unreachable', async () => {
    const m = await mount({ failing: true });
    try {
      let f = await m.frame();
      expect(f).toContain('Daemon unreachable');
      f = await m.key('a');
      expect(m.client.calls.filter((c) => c.method === 'answer')).toHaveLength(0);
    } finally {
      m.done();
    }
  });

  test('help opens with ? and a small terminal shows the notice', async () => {
    const m = await mount();
    try {
      const f = await m.key('?');
      expect(f).toContain('Keys');
      expect(f).toContain('j/k or ↑/↓');
      await m.key('q');
      expect(m.store.get().view).toBe('dashboard');
    } finally {
      m.done();
    }
    const small = await mount({ width: 50, height: 10 });
    try {
      expect(await small.frame()).toContain('Terminal too small');
    } finally {
      small.done();
    }
  });

  test('narrow terminals show one pane and tab switches it', async () => {
    const m = await mount({ width: 80 });
    try {
      let f = await m.frame();
      expect(f).toContain('Runs');
      expect(f).not.toContain('analyse');
      f = await m.key('tab');
      expect(f).toContain('analyse');
    } finally {
      m.done();
    }
  });
});
