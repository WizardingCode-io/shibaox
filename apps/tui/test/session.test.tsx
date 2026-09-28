import { expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import type { RunState } from '@wizardingcode/shibaox-core';
import type { Envelope } from '@wizardingcode/shibaox-daemon';
import { App, type AppHooks } from '../src/app.js';
import { CARD_LIMIT } from '../src/model/stream.js';
import { FakeDaemonClient } from '../src/testing/fake-client.js';

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const snapshot = {
  workflow: 'hello-feature',
  start: 'analyse',
  nodes: {
    analyse: { type: 'task', role: 'analyst', next: 'implement' },
    implement: { type: 'task', role: 'backend', next: 'qa' },
    qa: { type: 'gate', gates: ['tests'], on_pass: 'judge', on_fail: 'implement', max_retries: 3 },
    judge: {
      type: 'decide',
      by: 'jev',
      options: ['ship', 'rework'],
      next: { ship: 'ship', rework: 'implement' },
    },
    ship: { type: 'human', action: 'ship' },
  },
};

const run = (runId: string, status = 'running') =>
  ({
    runId,
    workflow: 'hello-feature',
    status,
    createdAt: '2026-09-26T10:00:00Z',
    updatedAt: '2026-09-26T10:00:00Z',
    spentUsd: 0.002,
  }) as never;
const state = (runId: string, over: Partial<RunState> = {}): RunState =>
  ({
    runId,
    workflow: 'hello-feature',
    workflowSnapshot: snapshot,
    input: {},
    workspace: '/w',
    adapter: 'claude-code',
    status: 'running',
    nodes: {},
    spentUsd: 0.002,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
    branch: 'shibaox/run-r1',
    ...over,
  }) as RunState;
let seq = 0;
const ev = (event: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq: ++seq,
    cursor: `${seq}:0`,
    event: {
      runId: 'r1',
      at: `2026-09-26T10:0${Math.min(9, Math.floor(seq / 10))}:${String(seq % 60).padStart(2, '0')}Z`,
      seq,
      ...event,
    },
  }) as unknown as Envelope;
const rt = (nodeId: string, event: Record<string, unknown>): Envelope =>
  ({
    kind: 'runtime',
    seq: ++seq,
    cursor: `0:${seq}`,
    event: { runId: 'r1', nodeId, seq, at: 'x', event },
  }) as unknown as Envelope;
const end = (status: string): Envelope =>
  ({ kind: 'end', seq: ++seq, cursor: 'e', status }) as unknown as Envelope;

async function mount(o: {
  state: RunState;
  history: Envelope[];
  runs?: unknown[];
  width?: number;
  height?: number;
}) {
  const client = new FakeDaemonClient();
  client.runs = (o.runs as never[]) ?? [run('r1', o.state.status)];
  client.states.set('r1', o.state);
  client.history.set('r1', o.history);
  const exits: number[] = [];
  let hooks: AppHooks | undefined;
  const setup = await testRender(
    () => (
      <App
        client={client}
        runId="r1"
        version="0.0.1"
        home="/tmp/shx-home"
        cwd="/tmp"
        env={{ SHIBAOX_NO_MOTION: '1' }}
        onExit={(c) => exits.push(c)}
        onMount={(h) => {
          hooks = h;
        }}
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
  const key = async (k: string) => {
    if (k === 'return') await setup.mockInput.pressEnter();
    else await setup.mockInput.pressKey(k);
    return frame();
  };
  if (!hooks) throw new Error('hooks missing');
  return { client, setup, frame, key, exits, hooks, done: () => setup.renderer.destroy() };
}

test('a running task shows its text, tool calls and header; enter expands a tool', async () => {
  const m = await mount({
    state: state('r1'),
    history: [
      ev({ type: 'RunStarted' }),
      ev({ type: 'NodeStarted', nodeId: 'analyse' }),
      rt('analyse', { type: 'text', text: 'Looking at the repo layout.' }),
      rt('analyse', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }),
      rt('analyse', {
        type: 'tool_result',
        id: 't1',
        name: 'Read',
        output: 'export const a = 1;',
        durationMs: 7,
      }),
    ],
  });
  try {
    let f = await m.frame();
    expect(f).toContain('● Working');
    expect(f).toContain('$0.0020');
    expect(f).toContain('analyse · analyst · claude-code');
    expect(f).toContain('1 tool');
    expect(f).toContain('Looking at the repo layout.');
    expect(f).toContain('⊙ Read src/a.ts');
    expect(f).toContain('7 ms');
    expect(f).not.toContain('export const a = 1;');
    f = await m.key('j'); // select the tool line
    f = await m.key('return');
    expect(f).toContain('export const a = 1;');
    f = await m.key('return');
    expect(f).not.toContain('export const a = 1;');
  } finally {
    m.done();
  }
});

test('gate, decide, human and summary cards for a finished run', async () => {
  const report = {
    gates: ['tests'],
    passed: false,
    checks: [
      {
        name: 'pnpm test',
        type: 'code',
        passed: false,
        skipped: false,
        evidence: '1 failing test',
      },
    ],
  };
  const nodes = {
    qa: { status: 'gate_failed', attempts: 1, approvals: {} },
    judge: { status: 'completed', attempts: 1, approvals: {}, choice: 'ship' },
    ship: { status: 'completed', attempts: 1, approvals: {} },
  } as never;
  const m = await mount({
    state: state('r1', { status: 'completed', nodes }),
    history: [
      ev({ type: 'RunStarted' }),
      ev({ type: 'NodeStarted', nodeId: 'qa' }),
      ev({ type: 'GateFailed', nodeId: 'qa', report, rework: 'implement' }),
      ev({ type: 'NodeStarted', nodeId: 'judge' }),
      ev({ type: 'DecisionMade', nodeId: 'judge', choice: 'ship', confidence: 0.91 }),
      ev({ type: 'NodeCompleted', nodeId: 'judge', output: {}, summary: '' }),
      ev({ type: 'NodeStarted', nodeId: 'ship' }),
      ev({ type: 'HumanRequested', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' }),
      ev({ type: 'HumanResponded', nodeId: 'ship', approved: true, note: 'go' }),
      rt('ship', { type: 'file_changed', path: 'src/a.ts' }),
      rt('ship', { type: 'file_changed', path: 'src/b.ts' }),
      ev({ type: 'NodeCompleted', nodeId: 'ship', output: {}, summary: '' }),
      ev({ type: 'RunCompleted' }),
      end('completed'),
    ],
  });
  try {
    const f = await m.frame();
    expect(f).toContain('✗ qa · gate');
    expect(f).toContain('[✗] pnpm test');
    expect(f).toContain('1 failing test');
    expect(f).toContain('judge → ship (0.91)');
    expect(f).toContain('Ship it?');
    expect(f).toContain('approved · go');
    expect(f).toContain('✓ Done · 3 nodes · $0.0020');
    expect(f).toContain('2 files changed');
    expect(f).toContain('shibaox/run-r1');
    expect(f).toContain('✓ Done');
    expect(m.exits).toEqual([]); // stream mode ends through runStream, not the App
  } finally {
    m.done();
  }
});

test('a run without stream shows node cards from state only', async () => {
  const nodes = Object.fromEntries(
    ['analyse', 'implement', 'qa', 'judge', 'ship'].map((id) => [
      id,
      { status: 'completed', attempts: 1, approvals: {} },
    ]),
  ) as never;
  const m = await mount({ state: state('r1', { status: 'completed', nodes }), history: [] });
  try {
    const f = await m.frame();
    for (const id of ['analyse', 'implement', 'qa', 'judge', 'ship']) expect(f).toContain(id);
    expect(f).toContain('✓ Done · 5 nodes');
    expect(f).not.toContain('Error');
  } finally {
    m.done();
  }
});

test('a 40 kB text block renders and the timeline caps at 5000 cards', async () => {
  const big = `${'lorem ipsum '.repeat(3400)}END-OF-TEXT`;
  const m = await mount({
    state: state('r1'),
    history: [
      ev({ type: 'NodeStarted', nodeId: 'analyse' }),
      rt('analyse', { type: 'text', text: big }),
    ],
  });
  try {
    await settle(300); // 40 kB of markdown takes a few frames to lay out
    let f = await m.frame();
    expect(f).toContain('END-OF-TEXT');
    f = await m.key('g');
    expect(f).toContain('analyse · analyst');
  } finally {
    m.done();
  }
  const many: Envelope[] = [];
  const nodes: Record<string, unknown> = {};
  for (let i = 0; i < CARD_LIMIT + 100; i++) {
    nodes[`n${i}`] = { type: 'task', role: 'r' };
    many.push(ev({ type: 'NodeStarted', nodeId: `n${i}` }));
  }
  const m2 = await mount({
    state: state('r1', { workflowSnapshot: { workflow: 'w', start: 'n0', nodes } as never }),
    history: many,
  });
  try {
    const f = await m2.key('g');
    expect(f).toMatch(/… \d+ earlier/); // 100 past the model cap plus the cards the screen does not mount
  } finally {
    m2.done();
  }
});

test('streaming frames keep the cards and blocks the same objects (no remount per batch)', async () => {
  const m = await mount({
    state: state('r1'),
    history: [
      ev({ type: 'NodeStarted', nodeId: 'analyse' }),
      rt('analyse', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }),
      rt('analyse', { type: 'tool_result', id: 't1', name: 'Read', output: 'ok', durationMs: 7 }),
      rt('analyse', { type: 'text', text: 'Start ' }),
    ],
  });
  try {
    await m.frame();
    const before = m.hooks.data.timeline('r1')();
    const card = before[0];
    expect(card?.kind).toBe('node');
    const tool = card?.kind === 'node' ? card.blocks[0] : undefined;
    for (let i = 0; i < 100; i++)
      m.client.pushFrame('r1', rt('analyse', { type: 'text', text: `word${i} ` }));
    await settle(400);
    await m.frame();
    const after = m.hooks.data.timeline('r1')();
    expect(after[0]).toBe(card);
    expect(after[0]?.kind === 'node' ? after[0].blocks[0] : undefined).toBe(tool);
    expect(
      after[0]?.kind === 'node'
        ? after[0].blocks[1]?.kind === 'text' && after[0].blocks[1].text
        : '',
    ).toContain('word99');
    expect(m.hooks.data.frameCount('r1')).toBe(104);
  } finally {
    m.done();
  }
});
