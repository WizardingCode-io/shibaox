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
  client.history.set('r1', [end('completed')]);
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
    expect(f).toContain('✓ Done');
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
    };
    expect(submit).toMatchObject({
      orgRoot: '/o',
      project: '/w',
      workflow: 'hello-feature',
      adapter: 'mock',
    });
    expect(submit.input).toContain('now add tests for it');
    expect(submit.input).toContain('add a health endpoint'); // the previous request travels as context
    expect(hooks?.data.state.open).toEqual(['r1']); // same tab
    expect(f).toContain('add a health endpoint');
    expect(f).toContain('now add tests for it');
    expect(f.indexOf('add a health endpoint')).toBeLessThan(f.indexOf('now add tests for it'));
    expect(f).not.toContain('Continue'); // the new run is working: the status box is back
  } finally {
    setup.renderer.destroy();
  }
});
