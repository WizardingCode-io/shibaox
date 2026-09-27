import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { App, type AppHooks } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const chatState = (runId: string, over: Partial<RunState> = {}): RunState =>
  ({
    runId,
    workflow: 'chat',
    workflowSnapshot: {
      workflow: 'chat',
      conversation: true,
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant', instruction: 'Reply to the user.' } },
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
    ...over,
  }) as unknown as RunState;
const run = (runId: string, status = 'completed') =>
  ({ runId, workflow: 'chat', status, createdAt: 'x', updatedAt: 'x', spentUsd: 0.04 }) as never;
const frames = (runId: string, text: string, status = 'completed'): Envelope[] =>
  [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId, at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'reply' },
    },
    {
      kind: 'runtime',
      seq: 2,
      cursor: '1:2',
      event: { runId, nodeId: 'reply', seq: 2, at: 'x', event: { type: 'text', text } },
    },
    {
      kind: 'run',
      seq: 3,
      cursor: '3:2',
      event: {
        runId,
        at: 'x',
        seq: 3,
        type: status === 'completed' ? 'NodeCompleted' : 'NodeFailed',
        nodeId: 'reply',
        output: {},
        summary: '',
        error: 'boom',
      },
    },
    { kind: 'end', seq: 9, cursor: '9:2', status },
  ] as unknown as Envelope[];

async function mount(client: FakeDaemonClient, runId: string) {
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
          h.data.openRun(runId);
        }}
      />
    ),
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return { setup, frame, hooks: () => hooks };
}

test('a chat run reads as a conversation: the request, then the reply without node chrome or a summary line', async () => {
  const client = new FakeDaemonClient();
  client.runs = [run('r1')];
  client.states.set('r1', chatState('r1'));
  client.history.set('r1', frames('r1', 'Olá! Em que posso ajudar?'));
  const m = await mount(client, 'r1');
  try {
    let f = await m.frame();
    // the reply streams in after the run is known to be done: wait for the text itself
    for (let i = 0; i < 60 && !f.includes('Olá! Em que posso ajudar?'); i++) f = await m.frame();
    expect(f).toContain('olá');
    expect(f).toContain('Olá! Em que posso ajudar?');
    expect(f).not.toContain('reply · assistant');
    expect(f).not.toContain('■ done');
    expect(f).not.toContain('✓ Done');
    expect(f).toContain('Continue');
  } finally {
    m.setup.renderer.destroy();
  }
});

test('a failed chat run keeps the summary line with its error', async () => {
  const client = new FakeDaemonClient();
  client.runs = [run('r1', 'failed')];
  client.states.set(
    'r1',
    chatState('r1', { status: 'failed', error: 'boom' } as Partial<RunState>),
  );
  client.history.set('r1', frames('r1', 'hmm', 'failed'));
  const m = await mount(client, 'r1');
  try {
    let f = await m.frame();
    for (let i = 0; i < 40 && !f.includes('✗ Failed'); i++) f = await m.frame();
    expect(f).toContain('✗ Failed');
    expect(f).toContain('boom');
  } finally {
    m.setup.renderer.destroy();
  }
});
