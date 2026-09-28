import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@wizardingcode/shibaox-core';
import type { InboxItem } from '@wizardingcode/shibaox-daemon';
import { App } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const state = (status = 'running'): RunState =>
  ({
    runId: 'r1',
    workflow: 'hello-feature',
    workflowSnapshot: {
      workflow: 'hello-feature',
      start: 'ship',
      nodes: { ship: { type: 'human', action: 'ship' } },
    },
    input: {},
    workspace: '/w',
    status,
    nodes: {},
    spentUsd: 0.1,
    budgetWarned: false,
    pendingHumans:
      status === 'waiting_human'
        ? [{ nodeId: 'ship', action: 'ship', prompt: 'Approve the push?' }]
        : [],
    pendingApprovals: [],
  }) as RunState;
const human: InboxItem = {
  id: 'human:r1:ship' as never,
  kind: 'human',
  runId: 'r1',
  nodeId: 'ship',
  at: 'x',
  prompt: 'Approve the push?',
  detail: { action: 'ship' },
};
const approval: InboxItem = {
  id: 'approval:a2' as never,
  kind: 'approval',
  runId: 'r1',
  nodeId: 'implement',
  at: 'x',
  prompt: 'git push origin main',
  detail: { role: 'backend', program: 'git', category: 'push' },
};

async function mount(o: { inbox: InboxItem[]; status?: string }) {
  const client = new FakeDaemonClient();
  client.runs = [
    {
      runId: 'r1',
      workflow: 'hello-feature',
      status: o.status ?? 'waiting_human',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0.1,
    } as never,
  ];
  client.states.set('r1', state(o.status ?? 'waiting_human'));
  client.inboxItems = o.inbox;
  const setup = await testRender(
    () => (
      <App
        client={client}
        runId="r1"
        version="0.0.1"
        home="/tmp/shx-home"
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={() => {}}
      />
    ),
    { width: 100, height: 24, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  const key = async (k: string) => {
    if (k === 'return') await setup.mockInput.pressEnter();
    else await setup.mockInput.pressKey(k);
    return frame();
  };
  const answers = () => client.calls.filter((c) => c.method === 'answer');
  return { client, setup, frame, key, answers, done: () => setup.renderer.destroy() };
}

test('approvals come first and ask y; d denies; n adds a note; a human item answers at once', async () => {
  const m = await mount({ inbox: [human, approval] });
  try {
    let f = await m.frame();
    expect(f).toContain('▲ git push origin main · backend · [a]pprove [d]eny [n]ote');
    expect(f).toContain('+1 more waiting');
    f = await m.key('a');
    expect(f).toContain('Approve git push origin main? (y/n)');
    expect(m.answers()).toHaveLength(0);
    await m.key('y');
    expect(m.answers().at(-1)?.args).toEqual([
      'approval:a2',
      { approved: true, note: undefined, via: 'cli' },
    ]);
    await m.key('d');
    expect(m.answers().at(-1)?.args).toEqual([
      'approval:a2',
      { approved: false, note: undefined, via: 'cli' },
    ]);
    f = await m.key('n');
    expect(f).toContain('Note');
    await m.setup.mockInput.typeText('looks fine');
    await settle();
    await m.key('return');
    expect(m.answers().at(-1)?.args).toEqual([
      'approval:a2',
      { approved: true, note: 'looks fine', via: 'cli' },
    ]);
    m.client.inboxItems = [human];
    await settle(1100); // the next poll drops the answered approval
    f = await m.frame();
    expect(f).toContain('▲ Approve the push? · ship · [a]pprove [d]eny [n]ote');
    await m.key('a');
    expect(m.answers().at(-1)?.args).toEqual([
      'human:r1:ship',
      { approved: true, note: undefined, via: 'cli' },
    ]);
  } finally {
    m.done();
  }
});

test('a 409 clears the approval bar on the next tick', async () => {
  const m = await mount({ inbox: [human] });
  try {
    m.client.answerError = {
      status: 409,
      code: 'already_resolved',
      message: 'was already answered',
    };
    await m.frame(); // the bar is up once the first poll delivered the inbox
    let f = await m.key('a');
    expect(f).toContain('Already answered elsewhere');
    m.client.inboxItems = [];
    await settle(1100);
    f = await m.frame();
    expect(f).not.toContain('[a]pprove');
    expect(f).toContain('enter expand');
  } finally {
    m.done();
  }
});

test('c confirms before cancelling; r only resumes a paused run; d without a pending item answers nothing', async () => {
  const m = await mount({ inbox: [], status: 'running' });
  try {
    let f = await m.key('c');
    expect(f).toContain('Cancel run r1?');
    await m.key('y');
    expect(m.client.calls.find((c) => c.method === 'cancel')?.args).toEqual(['r1']);
    f = await m.key('r');
    // the cancel toast is still showing; the resume notice queues behind it
    expect(f.includes('Nothing to resume') || f.includes('+1 more')).toBe(true);
    expect(m.client.calls.some((c) => c.method === 'resume')).toBe(false);
    await m.key('d');
    expect(m.answers()).toHaveLength(0);
  } finally {
    m.done();
  }
});

test('typing a note never reaches the session shortcuts (c, y, j, ?)', async () => {
  const m = await mount({ inbox: [human] });
  try {
    await m.frame();
    let f = await m.key('n');
    expect(f).toContain('Note');
    await m.setup.mockInput.typeText('could you retry?');
    await settle();
    f = await m.frame();
    expect(f).not.toContain('Cancel run');
    expect(f).not.toContain('Keys');
    expect(m.client.calls.some((c) => c.method === 'cancel')).toBe(false);
    await m.key('return');
    expect(m.answers().at(-1)?.args).toEqual([
      'human:r1:ship',
      { approved: true, note: 'could you retry?', via: 'cli' },
    ]);
  } finally {
    m.done();
  }
});

test('r resumes a paused run', async () => {
  const m = await mount({ inbox: [], status: 'paused_budget' });
  try {
    await m.key('r');
    expect(m.client.calls.find((c) => c.method === 'resume')?.args[0]).toBe('r1');
  } finally {
    m.done();
  }
});
