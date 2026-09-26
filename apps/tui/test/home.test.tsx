import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { testRender } from '@opentui/solid';
import { scaffoldOrg } from '@shibaox/daemon';
import { App } from '../src/app.js';
import { loadPrefs } from '../src/context/prefs.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mount(o: { width?: number; height?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-home-'));
  scaffoldOrg(dir); // writes <dir>/org
  const home = join(dir, 'home');
  const client = new FakeDaemonClient();
  const exits: number[] = [];
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={home}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={(c) => exits.push(c)}
      />
    ),
    { width: o.width ?? 100, height: o.height ?? 30, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const type = async (text: string) => {
    for (const ch of text) {
      await setup.mockInput.typeText(ch);
      await settle(5);
    }
    return frame();
  };
  const done = () => {
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, home, client, setup, frame, type, exits, done };
}

test('home shows the logo, prompt, context line and daemon footer', async () => {
  const m = await mount();
  try {
    const f = await m.frame();
    expect(f).toContain('█');
    expect(f).toContain('Add a /health endpoint');
    expect(f).toContain(`org ${basename(m.dir)}/org`);
    expect(f).toContain('workflow hello-feature');
    expect(f).toContain('adapter mock');
    expect(f).toContain('daemon 0.0.1 · 0 running · 0 queued');
    expect(f).toContain('ctrl+o runs');
  } finally {
    m.done();
  }
});

test('slash commands autocomplete and change the context; enter submits and opens the session', async () => {
  const m = await mount();
  try {
    let f = await m.type('/wor');
    expect(f).toContain('/workflow');
    await m.setup.mockInput.pressTab();
    f = await m.frame();
    expect(f).toContain('/workflow ');
    await m.type('hel');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('workflow hello-feature');
    await m.type('/budget abc');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('Budget must be a number');
    await m.type('/adapter direct');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('adapter direct');
    await m.type('add /health');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    const submit = m.client.calls.find((c) => c.method === 'submitRun');
    expect(submit?.args[0]).toEqual({
      orgRoot: join(m.dir, 'org'),
      project: m.dir,
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'direct',
      workspace: undefined,
      budgetUsd: undefined,
    });
    expect(loadPrefs(m.home)).toMatchObject({
      lastOrg: join(m.dir, 'org'),
      lastAdapter: 'direct',
      lastWorkflow: 'hello-feature',
    });
    expect(f).toContain('session new-run');
  } finally {
    m.done();
  }
});

test('an unknown org blocks submit; ctrl+c clears the text first and exits when empty', async () => {
  const m = await mount();
  try {
    await m.type('/org /nope/nothing');
    await m.setup.mockInput.pressEnter();
    let f = await m.frame();
    expect(f).toContain('Org not found');
    await m.type('do it');
    await m.setup.mockInput.pressEnter();
    await m.frame();
    expect(m.client.calls.some((c) => c.method === 'submitRun')).toBe(false);
    await m.setup.mockInput.pressKey('c', { ctrl: true });
    f = await m.frame();
    expect(f).not.toContain('do it');
    expect(m.exits).toEqual([]);
    await m.setup.mockInput.pressKey('c', { ctrl: true });
    await settle();
    expect(m.exits).toEqual([0]);
  } finally {
    m.done();
  }
});

test('a short terminal hides the logo but keeps the prompt', async () => {
  const m = await mount({ width: 60, height: 18 });
  try {
    const f = await m.frame();
    expect(f).not.toContain('█');
    expect(f).toContain('Add a /health endpoint');
  } finally {
    m.done();
  }
});
