import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import { scaffoldOrg } from '@shibaox/daemon';
import { App, type AppHooks } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const run = (runId: string, status: string) =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    spentUsd: 0.1,
  }) as never;
const state = (runId: string, status: string): RunState =>
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

async function mount(o: { open?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-dialogs-'));
  scaffoldOrg(dir);
  const client = new FakeDaemonClient();
  client.runs = [run('aaaa1111-x', 'running'), run('bbbb2222-x', 'completed')];
  for (const r of client.runs as { runId: string; status: string }[])
    client.states.set(r.runId, state(r.runId, r.status));
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={join(dir, 'home')}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
        onMount={(h) => {
          hooks = h;
          for (const id of o.open ?? []) h.data.openRun(id);
        }}
      />
    ),
    { width: 160, height: 30, exitOnCtrlC: false },
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
    else if (k === 'escape') await setup.mockInput.pressEscape();
    else await setup.mockInput.pressKey(k, mods);
    return frame();
  };
  const type = async (text: string) => {
    for (const ch of text) {
      await setup.mockInput.typeText(ch);
      await settle(5);
    }
    return frame();
  };
  if (!hooks) throw new Error('hooks missing');
  return {
    client,
    setup,
    frame,
    key,
    type,
    hooks,
    done: () => {
      setup.renderer.destroy();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('ctrl+o opens the runs picker: fuzzy filter, enter opens the run in a tab', async () => {
  const m = await mount();
  try {
    await m.frame();
    let f = await m.key('o', { ctrl: true });
    expect(f).toContain('Runs');
    expect(f).toContain('aaaa1111');
    expect(f).toContain('bbbb2222');
    f = await m.type('bbbb');
    expect(f).toContain('bbbb2222');
    expect(f.split('\n').filter((l) => l.includes('aaaa1111'))).toHaveLength(0);
    await m.key('return');
    expect(m.hooks.data.state.active).toBe('bbbb2222-x');
    expect(m.hooks.data.state.open).toEqual(['bbbb2222-x']);
  } finally {
    m.done();
  }
});

test('ctrl+k opens the command palette and runs the chosen command', async () => {
  const m = await mount({ open: ['aaaa1111-x'] });
  try {
    let f = await m.frame();
    expect(f).toContain('Needs you (0)'); // the sidebar is open at 160 columns
    f = await m.key('k', { ctrl: true });
    expect(f).toContain('New run');
    expect(f).toContain('ctrl+n');
    f = await m.type('side');
    expect(f).toContain('Toggle sidebar');
    await m.key('return');
    f = await m.frame();
    expect(f).not.toContain('Toggle sidebar');
    expect(f).not.toContain('Needs you (0)');
  } finally {
    m.done();
  }
});

test('? opens help in a session but types into the home prompt', async () => {
  const m = await mount({ open: ['aaaa1111-x'] });
  try {
    await m.frame();
    let f = await m.key('?');
    expect(f).toContain('Keys');
    expect(f).toContain('ctrl+o');
    await m.key('escape');
    f = await m.key('n', { ctrl: true });
    expect(f).toContain('Add a /health endpoint');
    f = await m.key('?');
    expect(f).not.toContain('Keys');
    expect(f).toContain('› ?');
  } finally {
    m.done();
  }
});
