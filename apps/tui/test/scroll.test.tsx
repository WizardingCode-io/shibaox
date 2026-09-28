import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@wizardingcode/shibaox-core';
import type { Envelope } from '@wizardingcode/shibaox-daemon';
import { App } from '../src/app.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/** Twelve completed task nodes with a few tool lines each: far taller than a 30-row terminal. */
function longRun() {
  const nodes: Record<string, unknown> = {};
  const history: Envelope[] = [];
  let seq = 0;
  const ev = (event: Record<string, unknown>): Envelope =>
    ({
      kind: 'run',
      seq: ++seq,
      cursor: `${seq}:0`,
      event: { runId: 'r1', at: '2026-09-27T10:00:00Z', seq, ...event },
    }) as unknown as Envelope;
  const rt = (nodeId: string, event: Record<string, unknown>): Envelope =>
    ({
      kind: 'runtime',
      seq: ++seq,
      cursor: `0:${seq}`,
      event: { runId: 'r1', nodeId, seq, at: 'x', event },
    }) as unknown as Envelope;
  history.push(ev({ type: 'RunStarted' }));
  for (let i = 0; i < 12; i++) {
    const id = `node${String(i).padStart(2, '0')}`;
    nodes[id] = { type: 'task', role: 'r' };
    history.push(ev({ type: 'NodeStarted', nodeId: id }));
    history.push(rt(id, { type: 'text', text: `Working on ${id}.` }));
    for (let t = 0; t < 3; t++) {
      history.push(
        rt(id, {
          type: 'tool_use',
          id: `${id}-t${t}`,
          name: 'Read',
          input: { file_path: `src/${id}-${t}.ts` },
        }),
      );
      history.push(
        rt(id, {
          type: 'tool_result',
          id: `${id}-t${t}`,
          name: 'Read',
          output: 'ok',
          durationMs: 3,
        }),
      );
    }
    history.push(
      ev({ type: 'NodeCompleted', nodeId: id, output: {}, summary: '', cost: { usd: 0.001 } }),
    );
  }
  history.push(ev({ type: 'RunCompleted' }));
  history.push({
    kind: 'end',
    seq: ++seq,
    cursor: 'e',
    status: 'completed',
  } as unknown as Envelope);
  const state = {
    runId: 'r1',
    workflow: 'hello-feature',
    workflowSnapshot: { workflow: 'hello-feature', start: 'node00', nodes },
    input: { spec: 'a long run' },
    workspace: '/w',
    adapter: 'mock',
    status: 'completed',
    nodes: {},
    spentUsd: 0.012,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
  } as unknown as RunState;
  return { state, history };
}

async function mount() {
  const { state, history } = longRun();
  const client = new FakeDaemonClient();
  client.runs = [
    {
      runId: 'r1',
      workflow: 'hello-feature',
      status: 'completed',
      createdAt: 'x',
      updatedAt: 'x',
      spentUsd: 0.012,
    } as never,
  ];
  client.states.set('r1', state);
  client.history.set('r1', history);
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
    { width: 100, height: 30, exitOnCtrlC: false },
  );
  const frame = async () => {
    await settle();
    await setup.renderOnce();
    await settle();
    await setup.renderOnce();
    return setup.captureCharFrame();
  };
  return { setup, frame, done: () => setup.renderer.destroy() };
}

test('a long run opens at its end, k/j move the view, g/G jump, and the mouse wheel scrolls', async () => {
  const m = await mount();
  try {
    await settle(300);
    let f = await m.frame();
    expect(f).toContain('✓ Done · 12 nodes'); // opened at the end
    expect(f).not.toContain('node00 · r');
    await m.setup.mockInput.pressKey('g');
    f = await m.frame();
    expect(f).toContain('a long run'); // the request block at the top
    expect(f).toContain('node00 · r');
    expect(f).not.toContain('✓ Done · 12 nodes');
    // j walks the cursor down the headers and tool lines; the view follows the cursor
    for (let i = 0; i < 24; i++) await m.setup.mockInput.pressKey('j');
    f = await m.frame();
    expect(f).not.toContain('node00 · r');
    expect(f).toContain('node0');
    await m.setup.mockInput.pressKey('G', { shift: true });
    f = await m.frame();
    expect(f).toContain('✓ Done · 12 nodes');
    // the arrows scroll the view without moving the cursor
    for (let i = 0; i < 12; i++) await m.setup.mockInput.pressArrow('up');
    f = await m.frame();
    expect(f).not.toContain('✓ Done · 12 nodes');
    for (let i = 0; i < 12; i++) await m.setup.mockInput.pressArrow('down');
    f = await m.frame();
    expect(f).toContain('✓ Done · 12 nodes');
    // the mouse wheel over the conversation scrolls it up
    await m.setup.mockMouse.scroll(40, 10, 'up');
    await m.setup.mockMouse.scroll(40, 10, 'up');
    await m.setup.mockMouse.scroll(40, 10, 'up');
    f = await m.frame();
    expect(f).not.toContain('✓ Done · 12 nodes');
  } finally {
    m.done();
  }
});
