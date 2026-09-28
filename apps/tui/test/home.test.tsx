import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { ProjectProfile } from '@shibaox/core';
import type { ModelChoice } from '@shibaox/daemon';
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
    models?: ModelChoice[];
    /** Open the dashboard in a directory without an org (a fresh project). */
    noLocalOrg?: boolean;
    /** The daemon is not up yet when the dashboard opens (a fresh install starts it on demand). */
    daemonDown?: boolean;
    /** `defaultOrg()` fails this many times first (a daemon still settling). */
    defaultOrgFailures?: number;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'tui-home-'));
  scaffoldOrg(dir); // writes <dir>/org
  const home = join(dir, 'home');
  const client = new FakeDaemonClient();
  if (o.daemonDown) client.failing = true;
  if (o.defaultOrgFailures) {
    client.defaultOrgRoot = join(dir, 'org');
    client.defaultOrgFailures = o.defaultOrgFailures;
  }
  const cwd = o.noLocalOrg ? join(dir, 'proj') : dir;
  if (o.noLocalOrg) mkdirSync(cwd, { recursive: true });
  if (o.profile) client.profiles.set(dir, o.profile);
  if (o.models) client.modelChoices = o.models;
  const exits: number[] = [];
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={home}
        cwd={cwd}
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

test('/model lists the daemon models with their state; the choice travels with the run and is remembered', async () => {
  const m = await mount({
    models: [
      // the unconfigured twin matches "haiku" just as well: it must never win the enter
      {
        ref: 'anthropic/claude-haiku-4-5',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        configured: false,
        missing: ['ANTHROPIC_API_KEY'],
      },
      {
        ref: 'anthropic-subscription/claude-haiku-4-5',
        provider: 'anthropic-subscription',
        model: 'claude-haiku-4-5',
        configured: true,
        runtime: 'claude-code',
      },
      {
        ref: 'openai/gpt-5',
        provider: 'openai',
        model: 'gpt-5',
        configured: false,
        missing: ['OPENAI_API_KEY'],
      },
      {
        ref: 'openrouter/google/gemini-2.5-flash',
        provider: 'openrouter',
        model: 'google/gemini-2.5-flash',
        configured: true,
        contextWindow: 1048576,
        pricing: { input_per_m: 0.3, output_per_m: 2.5 },
      },
      {
        ref: 'lmstudio/qwen3',
        provider: 'lmstudio',
        model: 'qwen3',
        configured: true,
        local: true,
        available: true,
        free: true,
      },
    ],
  });
  try {
    let f = await m.type('/model ');
    expect(f).toContain('anthropic-subscription/claude-haiku-4-5');
    expect(f).toContain('openai/gpt-5');
    expect(f).toContain('OPENAI_API_KEY'); // why it cannot be used yet
    expect(f).toContain('$0.30/$2.50 per M · 1.0M ctx'); // what a model costs and holds
    expect(f).toContain('local · free');
    f = await m.type('haiku');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('model anthropic-subscription/claude-haiku-4-5');
    expect(f).not.toContain('adapter '); // implied by the model
    // choosing an adapter by hand drops the model; "default" does too
    await m.type('/adapter direct');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('adapter direct');
    expect(f).not.toContain('model anthropic');
    await m.type('/model haiku');
    await m.setup.mockInput.pressEnter();
    await m.type('/model default');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).not.toContain('model anthropic');
    await m.type('/model haiku');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('model anthropic-subscription/claude-haiku-4-5');
    await m.type('olá');
    await m.setup.mockInput.pressEnter();
    await m.frame();
    const req = m.client.calls.find((c) => c.method === 'submitRun')?.args[0] as {
      model?: string;
      adapter?: string;
    };
    expect(req.model).toBe('anthropic-subscription/claude-haiku-4-5');
    expect(req.adapter).toBe('claude-code');
    expect(loadPrefs(m.home)).toMatchObject({
      lastModel: 'anthropic-subscription/claude-haiku-4-5',
    });
  } finally {
    m.done();
  }
});

test('/keys shows the vault and /key sets a key through the daemon', async () => {
  const m = await mount();
  try {
    m.client.keyRows = [
      { name: 'OPENROUTER_API_KEY', description: 'OpenRouter', set: false },
      { name: 'ANTHROPIC_API_KEY', description: 'Anthropic (API key)', set: true, source: 'env' },
      {
        name: 'TYPESAFE_API_KEY',
        description: 'Jev decisions and checks',
        set: true,
        source: 'vault',
        masked: 'ts_1…cdef',
      },
    ];
    let f = await m.type('/keys');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('Keys');
    expect(f).toContain('OPENROUTER_API_KEY');
    expect(f).toContain('ts_1…cdef');
    expect(f).toContain('env');
    // set keys first, then the missing ones: ANTHROPIC, TYPESAFE, OPENROUTER
    await m.setup.mockInput.pressArrow('down');
    await m.setup.mockInput.pressArrow('down');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('value for OPENROUTER_API_KEY');
    f = await m.type('sk-or-1234567890');
    expect(f).not.toContain('sk-or-1234567890'); // masked while typing
    expect(f).toContain('••••••••');
    // a long value never runs past the dialog: the dots are capped and the count says the rest
    f = await m.type('x'.repeat(80));
    expect(f).not.toMatch(/•{41}/);
    expect(f).toContain('(96 chars)');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(m.client.calls.find((c) => c.method === 'setKey')?.args).toEqual([
      'OPENROUTER_API_KEY',
      `sk-or-1234567890${'x'.repeat(80)}`,
    ]);
    expect(f).not.toContain('sk-or-1234567890');
    // x removes the selected key
    await m.setup.mockInput.pressArrow('up');
    await m.setup.mockInput.pressKey('x');
    f = await m.frame();
    expect(m.client.calls.find((c) => c.method === 'unsetKey')?.args).toEqual(['TYPESAFE_API_KEY']);
    await m.setup.mockInput.pressEscape();
    await m.frame(); // the prompt takes the focus back after the dialog
    await m.type('/key OPENROUTER_API_KEY sk-or-1234567890');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    const calls = m.client.calls.filter((c) => c.method === 'setKey');
    expect(calls.at(-1)?.args).toEqual(['OPENROUTER_API_KEY', 'sk-or-1234567890']);
    expect(f).not.toContain('sk-or-1234567890'); // the value never stays on screen
  } finally {
    m.done();
  }
});

test('without an org next to the project, the home uses the org under the shibaox home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tui-noorg-'));
  const home = join(dir, 'home');
  scaffoldOrg(home); // the daemon keeps the default org at <home>/org
  const project = join(dir, 'proj');
  mkdirSync(project);
  const client = new FakeDaemonClient();
  client.defaultOrgRoot = join(home, 'org');
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home={home}
        cwd={project}
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
    let f = setup.captureCharFrame();
    expect(f).toContain('workflow chat'); // the default org loaded: its chat is the workflow
    expect(f).not.toContain('Org not found');
    for (const ch of 'olá') {
      await setup.mockInput.typeText(ch);
      await settle(5);
    }
    await setup.mockInput.pressEnter();
    await settle();
    await setup.renderOnce();
    f = setup.captureCharFrame();
    const req = client.calls.find((c) => c.method === 'submitRun')?.args[0] as { orgRoot: string };
    expect(req.orgRoot).toBe(join(home, 'org'));
  } finally {
    setup.renderer.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the org's adapter is the dashboard's default runtime", async () => {
  const m = await mount({
    models: [
      { ref: 'openrouter/openai/gpt-5', provider: 'openrouter', model: 'gpt-5', configured: true },
    ],
  });
  try {
    writeFileSync(
      join(m.dir, 'org', 'org.yaml'),
      `${readFileSync(join(m.dir, 'org', 'org.yaml'), 'utf8')}\nadapter: claude-code\n`,
    );
    // the home reads the org again after a /tiers save; here the file changed under it
    m.client.orgConfigs.set(join(m.dir, 'org'), {
      root: join(m.dir, 'org'),
      organization: 'my-org',
      adapter: 'claude-code',
      tiers: { strong: 'anthropic/claude-sonnet-5' },
    });
    await m.type('/tiers');
    await m.setup.mockInput.pressEnter();
    await m.setup.mockInput.pressEnter(); // strong → model list
    await new Promise((r) => setTimeout(r, 20));
    await m.type('gpt');
    await m.setup.mockInput.pressEnter(); // saved: the home reads the org again
    await m.setup.mockInput.pressEscape();
    expect(await m.frame()).toContain('adapter claude-code');
  } finally {
    m.done();
  }
});

test('/tiers shows the org tiers and changes one through the daemon', async () => {
  const m = await mount({
    models: [
      {
        ref: 'anthropic-subscription/claude-haiku-4-5',
        provider: 'anthropic-subscription',
        model: 'claude-haiku-4-5',
        configured: true,
        runtime: 'claude-code',
      },
      { ref: 'openrouter/openai/gpt-5', provider: 'openrouter', model: 'gpt-5', configured: true },
    ],
  });
  try {
    m.client.orgConfigs.set(join(m.dir, 'org'), {
      root: join(m.dir, 'org'),
      organization: 'my-org',
      per_run_usd: 5,
      tiers: {
        strong: 'anthropic/claude-sonnet-5',
        cheap: 'ollama/llama3.2',
        decision: 'jev-latest',
      },
    });
    await m.type('/tiers');
    await m.setup.mockInput.pressEnter();
    let f = await m.frame();
    expect(f).toContain('Tiers');
    expect(f).toContain('strong');
    expect(f).toContain('anthropic/claude-sonnet-5');
    expect(f).toContain('decision');
    expect(f).toContain('jev-latest');
    // strong is the first row: enter opens the model list, typing filters, enter saves
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('openrouter/openai/gpt-5');
    await m.type('gpt');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    const call = m.client.calls.find((c) => c.method === 'setOrgConfig');
    expect(call?.args).toEqual([
      join(m.dir, 'org'),
      { tiers: { strong: 'openrouter/openai/gpt-5' } },
    ]);
    // escape inside the model list goes back to the rows; a second one closes the dialog
    await m.setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 20));
    expect(await m.frame()).toContain('type to filter');
    await m.setup.mockInput.pressEscape();
    f = await m.frame();
    expect(f).toContain('Tiers');
    expect(f).not.toContain('type to filter');
    await m.setup.mockInput.pressEscape();
    expect(await m.frame()).not.toContain('Tiers ·');
  } finally {
    m.done();
  }
});

test('a fresh install: the default org is asked again after a transient failure, and no error flashes meanwhile', async () => {
  const m = await mount({ noLocalOrg: true, defaultOrgFailures: 2 });
  try {
    let f = await m.frame();
    const until = Date.now() + 8_000;
    while (Date.now() < until && !f.includes('workflow chat')) {
      expect(f).not.toContain('Org not found');
      f = await m.frame();
    }
    expect(f).toContain('workflow chat');
    expect(m.client.calls.filter((c) => c.method === 'defaultOrg').length).toBe(3);
  } finally {
    m.done();
  }
}, 20_000);
