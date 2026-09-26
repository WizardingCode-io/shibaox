import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { App } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const state: RunState = {
  runId: 'r1',
  workflow: 'hello-feature',
  workflowSnapshot: {
    workflow: 'hello-feature',
    start: 'analyse',
    nodes: { analyse: { type: 'task', role: 'analyst' } },
  },
  input: {},
  workspace: '/w',
  status: 'running',
  nodes: { analyse: { status: 'running', attempts: 1, approvals: {} } },
  spentUsd: 0,
  budgetWarned: false,
  pendingHumans: [],
  pendingApprovals: [],
} as unknown as RunState;

async function frames(env: Record<string, string>) {
  const client = new FakeDaemonClient();
  client.runs = [
    {
      runId: 'r1',
      workflow: 'hello-feature',
      status: 'running',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0,
    } as never,
  ];
  client.states.set('r1', state);
  client.history.set('r1', [
    {
      kind: 'run',
      seq: 1,
      cursor: '1:0',
      event: { runId: 'r1', at: 'x', seq: 1, type: 'NodeStarted', nodeId: 'analyse' },
    } as unknown as Envelope,
  ]);
  const setup = await testRender(
    () => (
      <App
        client={client}
        runId="r1"
        version="0.0.1"
        home="/tmp/shx-home-motion"
        cwd="/tmp"
        env={env}
        onExit={() => {}}
      />
    ),
    { width: 100, height: 20, exitOnCtrlC: false },
  );
  try {
    await settle(120);
    await setup.renderOnce();
    const a = setup.captureCharFrame();
    await settle(300);
    await setup.renderOnce();
    const b = setup.captureCharFrame();
    return { a, b };
  } finally {
    setup.renderer.destroy();
  }
}

test('SHIBAOX_NO_MOTION freezes spinners and shimmer; with motion the frames keep changing', async () => {
  const off = await frames({ SHIBAOX_NO_MOTION: '1' });
  expect(off.a).toContain('▪ analyse');
  expect(off.a).toContain('● Working');
  expect(off.a).toBe(off.b);
  const on = await frames({});
  expect(on.a).toContain('Working');
  expect(on.a).not.toContain('▪ analyse');
  expect(on.a).not.toBe(on.b);
});
