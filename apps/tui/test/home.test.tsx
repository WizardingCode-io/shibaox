import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { ProjectProfile } from '@shibaox/core';
import { scaffoldOrg } from '@shibaox/daemon';
import { App } from '../src/app.js';
import { loadPrefs } from '../src/context/prefs.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mount(
  o: {
    width?: number;
    height?: number;
    env?: Record<string, string>;
    profile?: ProjectProfile;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-home-'));
  scaffoldOrg(dir); // writes <dir>/org
  const home = join(dir, 'home');
  const client = new FakeDaemonClient();
  if (o.profile) client.profiles.set(dir, o.profile);
  const exits: number[] = [];
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={home}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1', PATH: '/nonexistent', ...o.env }}
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
    expect(f).toContain('workflow chat'); // the org's chat workflow is the default entry
    expect(f).toContain('adapter direct');
    expect(f).toContain('project /');
    expect(f).toContain('daemon 0.0.1 · 0 running · 0 queued');
    expect(f).toContain('ctrl+o runs');
    expect(f).toContain('shibaox 0.0.1');
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
    expect(f).toContain('new-run'); // the run's tab and status box
  } finally {
    m.done();
  }
});

test('a command chosen from the list applies on enter; free-text commands ask for their value; /runs and /help open dialogs', async () => {
  const m = await mount();
  try {
    await m.frame();
    // /workflow + tab + enter picks the highlighted workflow instead of complaining
    await m.type('/workflow');
    await m.setup.mockInput.pressTab();
    await m.frame();
    await m.setup.mockInput.pressArrow('down'); // chat is first; hello-feature second
    await m.frame();
    await m.setup.mockInput.pressEnter();
    let f = await m.frame();
    expect(f).not.toContain('required');
    expect(f).toContain('workflow hello-feature');
    // /adapter + enter steps into its values; down + enter picks the second one
    await m.type('/adapter');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).not.toContain('must be');
    expect(f).toContain('› /adapter');
    await m.setup.mockInput.pressArrow('down');
    await m.frame();
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('adapter claude-code');
    // a free-text command keeps the prompt open with a hint, no red error
    await m.type('/project');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).not.toContain('required');
    expect(f).toContain('directory');
    expect(f).toContain('› /project');
    // a bad value shows the error, and typing again clears it
    await m.type(' /nope/nothing');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('Project not found');
    f = await m.type('x');
    expect(f).not.toContain('Project not found');
    await m.setup.mockInput.pressKey('c', { ctrl: true });
    await m.frame();
    // /runs and /help open their dialogs
    await m.type('/runs');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('type to filter');
    await m.setup.mockInput.pressEscape();
    await m.frame();
    await m.type('/help');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('Keys');
  } finally {
    m.done();
  }
});

test('an unknown org is refused and the current one stays; ctrl+c clears the text first and exits when empty', async () => {
  const m = await mount();
  try {
    await m.type('/org /nope/nothing');
    await m.setup.mockInput.pressEnter();
    let f = await m.frame();
    expect(f).toContain('Org not found');
    expect(f).toContain('workflow chat'); // the valid org stays
    await m.type('do it');
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

test('the adapter follows the org: a subscription tier runs through claude-code, an API tier through direct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-home-tier-'));
  scaffoldOrg(dir);
  const models = join(dir, 'org', 'models.yaml');
  writeFileSync(
    models,
    readFileSync(models, 'utf8').replace(
      'strong: anthropic/claude-sonnet-5',
      'strong: anthropic-subscription/claude-sonnet-5',
    ),
  );
  const client = new FakeDaemonClient();
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={join(dir, 'home')}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
      />
    ),
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  try {
    await settle(60);
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain('adapter claude-code');
  } finally {
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a mock run says so in the prompt and never becomes the remembered adapter', async () => {
  const m = await mount();
  try {
    let f = await m.frame();
    expect(f).toContain('adapter direct'); // the template's strong tier is an API model
    await m.type('/adapter mock');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('mock runs no model');
    await m.type('do it');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(loadPrefs(m.home).lastAdapter).toBeUndefined();
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

test('the home shows the project profile under the prompt', async () => {
  const m = await mount({
    profile: {
      name: 'demo',
      path: '/p',
      git: false,
      stack: ['JavaScript'],
      testCommand: 'npm test',
      files: 3,
      truncated: false,
      languages: [],
      summary: 'JavaScript · npm test · 3 files',
    },
  });
  try {
    const f = await m.frame();
    expect(f).toContain('JavaScript · npm test · 3 files');
  } finally {
    m.done();
  }
});

test('chat runs in place; opened in the home directory the project is ~/.shibaox/workspace', async () => {
  const m = await mount({ env: { HOME: '' } });
  try {
    // chat is the default workflow of the scaffolded org
    await m.type('olá');
    await m.setup.mockInput.pressEnter();
    await m.frame();
    const chat = m.client.calls.find((c) => c.method === 'submitRun')?.args[0] as {
      workflow: string;
      workspace?: string;
    };
    expect(chat.workflow).toBe('chat');
    expect(chat.workspace).toBe('inplace');
  } finally {
    m.done();
  }
});

test('opened in the home directory itself, the project is ~/.shibaox/workspace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-homedir-'));
  scaffoldOrg(dir);
  const client = new FakeDaemonClient();
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={join(dir, 'home')}
        cwd={dir}
        env={{ SHIBAOX_NO_MOTION: '1', PATH: '/nonexistent', HOME: dir }}
        onExit={() => {}}
      />
    ),
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  try {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    const f = setup.captureCharFrame();
    expect(f).toContain('~/.shibaox/workspace');
    for (const ch of 'olá') {
      await setup.mockInput.typeText(ch);
      await settle(5);
    }
    await setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
    const req = client.calls.find((c) => c.method === 'submitRun')?.args[0] as { project: string };
    expect(req.project).toBe(join(dir, '.shibaox', 'workspace'));
  } finally {
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
