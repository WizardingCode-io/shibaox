import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { App, type AppHooks } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const chatState = (): RunState =>
  ({
    runId: 'r1',
    workflow: 'chat',
    workflowSnapshot: {
      workflow: 'chat',
      conversation: true,
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant' } },
    },
    input: { spec: 'olá' },
    workspace: '/w',
    project: '/w',
    orgRoot: '/o',
    adapter: 'claude-code',
    status: 'completed',
    nodes: { reply: { status: 'completed', attempts: 1, approvals: {} } },
    spentUsd: 0.04,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as unknown as RunState;

async function mount(o: { models?: FakeDaemonClient['modelChoices'] } = {}) {
  const client = new FakeDaemonClient();
  if (o.models) client.modelChoices = o.models;
  client.runs = [
    {
      runId: 'r1',
      workflow: 'chat',
      status: 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0.04,
    } as never,
  ];
  client.states.set('r1', chatState());
  client.history.set('r1', [
    { kind: 'end', seq: 9, cursor: '9:0', status: 'completed' } as unknown as Envelope,
  ]);
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        version="0.0.1"
        home="/tmp/shx-home"
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
        onMount={(h) => {
          hooks = h;
          h.data.openRun('r1');
        }}
      />
    ),
    { width: 110, height: 34, exitOnCtrlC: false },
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
  let f = await frame();
  for (let i = 0; i < 40 && !f.includes('Continue'); i++) f = await frame();
  return { client, setup, frame, type, hooks: () => hooks };
}

test('typing / in the session prompt lists the commands with what they do; enter runs the chosen one', async () => {
  const m = await mount();
  try {
    let f = await m.type('/');
    expect(f).toContain('/diff');
    expect(f).toContain('Diff of the run');
    expect(f).toContain('/help');
    expect(f).toContain('/home');
    expect(f).not.toContain('/workflow'); // home-only commands stay on the home
    f = await m.type('hel');
    expect(f).toContain('/help');
    expect(f).not.toContain('/diff');
    // enter completes the highlighted name, a second enter runs it (as on the home)
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('› /help');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    expect(f).toContain('Keys'); // the help dialog
  } finally {
    m.setup.renderer.destroy();
  }
});

test('ctrl+c clears a typed command; plain text still continues the conversation', async () => {
  const m = await mount();
  try {
    await m.type('/di');
    await m.setup.mockInput.pressKey('c', { ctrl: true });
    let f = await m.frame();
    expect(f).not.toContain('/diff');
    expect(f).toContain('Continue');
    m.client.submitResult = { runId: 'r2', warnings: [] };
    await m.type('e agora?');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    const submit = m.client.calls.find((c) => c.method === 'submitRun')?.args[0] as
      | { input: string }
      | undefined;
    expect(submit?.input).toBe('e agora?');
  } finally {
    m.setup.renderer.destroy();
  }
});

test('keys pressed inside a dialog opened from the prompt never reach the input, and the prompt gets focus back', async () => {
  const m = await mount();
  try {
    await m.type('/help');
    await m.setup.mockInput.pressEnter();
    let f = await m.frame();
    expect(f).toContain('Keys');
    await m.type('jk'); // navigation keys of the dialog
    await m.setup.mockInput.pressEscape();
    f = await m.frame();
    expect(f).not.toContain('Keys');
    expect(f).not.toContain('› jk');
    f = await m.type('xyz');
    expect(f).toContain('› xyz'); // the prompt is focused again
  } finally {
    m.setup.renderer.destroy();
  }
});

test('/cancel is not offered on a finished run', async () => {
  const m = await mount();
  try {
    const f = await m.type('/');
    expect(f).not.toContain('/cancel');
    expect(f).toContain('/diff');
  } finally {
    m.setup.renderer.destroy();
  }
});

test('/model in the run tab sets the model of the next turn and shows it in the context line', async () => {
  const m = await mount({
    models: [
      {
        ref: 'anthropic-subscription/claude-sonnet-5',
        provider: 'anthropic-subscription',
        model: 'claude-sonnet-5',
        configured: true,
        runtime: 'claude-code',
      },
    ],
  });
  try {
    let f = await m.type('/model son');
    expect(f).toContain('anthropic-subscription/claude-sonnet-5');
    await m.setup.mockInput.pressEnter();
    f = await m.frame();
    // the context line (under the prompt), not only the toast
    const under = f.slice(f.indexOf('› Continue'));
    expect(under).toContain('anthropic-subscription/claude-sonnet-5');
    expect(f).toContain('Continue');
    // a ref that is not provider/model is refused
    await m.type('/model zzz'); // nothing in the list looks like it, and it is no provider/model
    await m.setup.mockInput.pressEnter();
    await m.frame();
    // refused: the tab keeps the model chosen before (the error toast queues behind the first one)
    expect(m.hooks()?.data.state.models.r1).toBe('anthropic-subscription/claude-sonnet-5');
    m.client.submitResult = { runId: 'r2', warnings: [] };
    await m.type('e agora?');
    await m.setup.mockInput.pressEnter();
    await m.frame();
    const submit = m.client.calls.find((c) => c.method === 'submitRun')?.args[0] as
      | { model?: string }
      | undefined;
    expect(submit?.model).toBe('anthropic-subscription/claude-sonnet-5');
  } finally {
    m.setup.renderer.destroy();
  }
});
