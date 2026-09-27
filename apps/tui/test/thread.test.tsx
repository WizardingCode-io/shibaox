import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { App, type AppHooks } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const state = (runId: string, spec: string, status = 'completed'): RunState =>
  ({
    runId,
    workflow: 'hello-feature',
    workflowSnapshot: {
      workflow: 'hello-feature',
      start: 'analyse',
      nodes: { analyse: { type: 'task', role: 'analyst' } },
    },
    input: { spec },
    workspace: '/w',
    project: '/w',
    orgRoot: '/o',
    adapter: 'mock',
    status,
    nodes: { analyse: { status: 'completed', attempts: 1, approvals: {} } },
    spentUsd: 0.001,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  }) as unknown as RunState;
const run = (runId: string, status = 'completed') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: 'x',
    updatedAt: 'x',
    spentUsd: 0.001,
  }) as never;
const end = (status: string): Envelope =>
  ({ kind: 'end', seq: 9, cursor: '9:0', status }) as unknown as Envelope;

test('a finished run shows the prompt; the next request runs in the same tab, after the first', async () => {
  const client = new FakeDaemonClient();
  client.runs = [run('r1')];
  client.states.set('r1', state('r1', 'add a health endpoint'));
  client.history.set('r1', [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId: 'r1', at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'analyse' },
    } as unknown as Envelope,
    {
      kind: 'runtime',
      seq: 2,
      cursor: '0:2',
      event: {
        runId: 'r1',
        nodeId: 'analyse',
        seq: 2,
        at: 'x',
        event: { type: 'text', text: 'Sure, here is the endpoint.' },
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
    { width: 120, height: 34, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  try {
    let f = await frame();
    expect(f).toContain('✓ Done'); // a one-task workflow without `conversation: true` is a normal run
    expect(f).toContain('› ');
    expect(f).toContain('Continue');
    // the follow-up run exists on the daemon once submitted
    client.states.set('r2', state('r2', 'now add tests for it', 'running'));
    client.runs = [run('r1'), run('r2', 'running')];
    for (const ch of 'now add tests for it') {
      await setup.mockInput.typeText(ch);
      await settle(5);
    }
    await setup.mockInput.pressEnter();
    f = await frame();
    const submit = client.calls.find((c) => c.method === 'submitRun')?.args[0] as {
      orgRoot: string;
      project: string;
      workflow: string;
      input: string;
      adapter: string;
      messages?: { role: string; content: string }[];
    };
    expect(submit).toMatchObject({
      orgRoot: '/o',
      project: '/w',
      workflow: 'hello-feature',
      adapter: 'mock',
    });
    // the new turn is the input; the conversation so far travels as structured messages
    expect(submit.input).toBe('now add tests for it');
    expect(submit.messages).toEqual([
      { role: 'user', content: 'add a health endpoint' },
      { role: 'assistant', content: 'Sure, here is the endpoint.' },
    ]);
    expect(hooks?.data.state.open).toEqual(['r1']); // same tab
    expect(f).toContain('add a health endpoint');
    expect(f).toContain('now add tests for it');
    expect(f.indexOf('add a health endpoint')).toBeLessThan(f.indexOf('now add tests for it'));
    expect(f).not.toContain('Continue'); // the new run is working: the status box is back
  } finally {
    setup.renderer.destroy();
  }
});

test('the next turn builds on the thread the daemon kept for the previous run (compacted), not on every run', async () => {
  const client = new FakeDaemonClient();
  const r1 = state('r1', 'add a health endpoint');
  r1.input = {
    spec: 'add a health endpoint',
    messages: [
      { role: 'user', content: 'Earlier: the schema was agreed.', summary: true },
      { role: 'user', content: 'what schema?' },
      { role: 'assistant', content: 'The one in docs.' },
    ],
  };
  client.states.set('r1', r1);
  client.runs = [run('r1')];
  client.history.set('r1', [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId: 'r1', at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'analyse' },
    } as unknown as Envelope,
    {
      kind: 'runtime',
      seq: 2,
      cursor: '0:2',
      event: {
        runId: 'r1',
        nodeId: 'analyse',
        seq: 2,
        at: 'x',
        event: { type: 'text', text: 'Sure, here is the endpoint.' },
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
    { width: 120, height: 34, exitOnCtrlC: false },
  );
  try {
    await settle();
    await setup.renderOnce();
    await settle();
    client.states.set('r2', state('r2', 'now add tests for it', 'running'));
    client.runs = [run('r1'), run('r2', 'running')];
    await hooks?.data.continueRun('r1', 'now add tests for it');
    const submit = client.calls.find((c) => c.method === 'submitRun')?.args[0] as {
      messages?: { role: string; content: string; summary?: boolean }[];
    };
    expect(submit.messages).toEqual([
      { role: 'user', content: 'Earlier: the schema was agreed.', summary: true },
      { role: 'user', content: 'what schema?' },
      { role: 'assistant', content: 'The one in docs.' },
      { role: 'user', content: 'add a health endpoint' },
      { role: 'assistant', content: 'Sure, here is the endpoint.' },
    ]);
  } finally {
    setup.renderer.destroy();
  }
});
