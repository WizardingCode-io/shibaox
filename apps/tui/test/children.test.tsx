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
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant' } },
    },
    input: { spec: 'adiciona um endpoint /health' },
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
const childState = (runId: string, parentRunId: string, status = 'running'): RunState =>
  ({
    runId,
    parentRunId,
    workflow: 'hello-feature',
    workflowSnapshot: {
      workflow: 'hello-feature',
      start: 'implement',
      nodes: { implement: { type: 'task', role: 'backend' } },
    },
    input: { spec: 'Add a /health endpoint with tests' },
    workspace: '/w/.shibaox/worktrees/c1',
    project: '/w',
    orgRoot: '/o',
    adapter: 'claude-code',
    workspaceMode: 'worktree',
    branch: 'shibaox/c1',
    status,
    nodes: {
      implement: {
        status: status === 'running' ? 'running' : 'completed',
        attempts: 1,
        approvals: {},
        summary: 'added /health',
      },
    },
    spentUsd: 0.2,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as unknown as RunState;
const run = (runId: string, workflow: string, status: string, parentRunId?: string) =>
  ({
    runId,
    workflow,
    status,
    createdAt: 'x',
    updatedAt: 'x',
    spentUsd: 0.04,
    parentRunId,
  }) as never;
const end = (status: string): Envelope =>
  ({ kind: 'end', seq: 9, cursor: '9:0', status }) as unknown as Envelope;

test('a run dispatched from the conversation joins its tab; when it ends the conversation continues with an event', async () => {
  const client = new FakeDaemonClient();
  client.runs = [run('r1', 'chat', 'completed')];
  client.states.set('r1', chatState('r1'));
  client.history.set('r1', [
    {
      kind: 'runtime',
      seq: 2,
      cursor: '0:2',
      event: {
        runId: 'r1',
        nodeId: 'reply',
        seq: 2,
        at: 'x',
        event: { type: 'text', text: 'Lancei hello-feature.' },
      },
    } as unknown as Envelope,
    end('completed'),
  ]);
  client.submitResult = { runId: 'r2', warnings: [] };
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
  try {
    await frame();
    // the daemon now lists the child run (start_workflow) and an unrelated child of a closed tab
    client.states.set('c1', childState('c1', 'r1'));
    client.states.set('zz', childState('zz', 'gone'));
    client.runs = [
      run('r1', 'chat', 'completed'),
      run('c1', 'hello-feature', 'running', 'r1'),
      run('zz', 'hello-feature', 'running', 'gone'),
    ];
    await hooks?.data.poller.tick();
    let f = await frame();
    for (let i = 0; i < 40 && !f.includes('→ hello-feature'); i++) f = await frame();
    expect(hooks?.data.threadOf('r1')).toEqual(['r1', 'c1']);
    expect(hooks?.data.state.open).toEqual(['r1']);
    expect(client.calls.some((c) => c.method === 'events' && c.args[0] === 'c1')).toBe(true);
    expect(f).toContain('→ hello-feature');
    expect(f).toContain('Add a /health endpoint with tests');
    expect(f).not.toContain('Continue'); // the child is working: the status box shows it
    // the child ends: the conversation continues with an event message for the orchestrator
    client.states.set('c1', childState('c1', 'r1', 'completed'));
    client.states.set(
      'r2',
      chatState('r2', {
        input: { spec: '[event] workflow hello-feature finished: completed' },
      } as Partial<RunState>),
    );
    client.pushFrame('c1', end('completed'));
    f = await frame();
    for (let i = 0; i < 40 && !client.calls.some((c) => c.method === 'submitRun'); i++)
      f = await frame();
    const submit = client.calls.find((c) => c.method === 'submitRun')?.args[0] as
      | { input: string; messages?: { role: string; content: string }[]; workflow: string }
      | undefined;
    expect(submit?.workflow).toBe('chat');
    expect(submit?.input.startsWith('[event] workflow hello-feature finished: completed')).toBe(
      true,
    );
    expect(submit?.input).toContain('added /health');
    expect(submit?.input).toContain('shibaox/c1');
    expect(submit?.messages).toEqual([
      { role: 'user', content: 'adiciona um endpoint /health' },
      { role: 'assistant', content: 'Lancei hello-feature.' },
    ]);
    expect(hooks?.data.threadOf('r1')).toEqual(['r1', 'c1', 'r2']);
    expect(client.calls.filter((c) => c.method === 'submitRun')).toHaveLength(1); // once per child
  } finally {
    setup.renderer.destroy();
  }
});
