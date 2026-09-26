import type { RunState } from '@shibaox/core';
import type { Envelope } from '@shibaox/daemon';
import { describe, expect, it } from 'vitest';
import { CARD_LIMIT, reduceTimeline, summarizeInput } from '../src/model/stream.js';

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
    ship: { type: 'human', action: 'ship', next: undefined },
  },
} as unknown as RunState['workflowSnapshot'];

const state = (over: Partial<RunState> = {}): RunState =>
  ({
    runId: 'r1',
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
const run = (event: Record<string, unknown>): Envelope =>
  ({
    kind: 'run',
    seq: ++seq,
    cursor: `${seq}:0`,
    event: { runId: 'r1', at: `2026-09-26T10:00:${String(seq).padStart(2, '0')}Z`, seq, ...event },
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

describe('reduceTimeline', () => {
  it('folds runtime frames into the node card', () => {
    const cards = reduceTimeline(state(), [
      run({ type: 'RunStarted' }),
      run({ type: 'NodeStarted', nodeId: 'analyse' }),
      rt('analyse', { type: 'text', text: 'Looking at ' }),
      rt('analyse', { type: 'text', text: 'the repo.' }),
      rt('analyse', { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/a.ts' } }),
      rt('analyse', { type: 'tool_result', id: 't1', name: 'Read', output: 'ok', durationMs: 7 }),
      rt('analyse', { type: 'file_changed', path: 'src/a.ts' }),
      run({
        type: 'NodeCompleted',
        nodeId: 'analyse',
        output: {},
        summary: '',
        cost: { usd: 0.001 },
      }),
    ]);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.kind).toBe('node');
    if (card?.kind !== 'node') return;
    expect(card.role).toBe('analyst');
    expect(card.runtime).toBe('claude-code');
    expect(card.status).toBe('completed');
    expect(card.costUsd).toBe(0.001);
    expect(card.tools).toBe(1);
    expect(card.blocks).toEqual([
      { kind: 'text', text: 'Looking at the repo.' },
      {
        kind: 'tool',
        id: 't1',
        name: 'Read',
        summary: 'src/a.ts',
        input: { file_path: 'src/a.ts' },
        output: 'ok',
        ms: 7,
        status: 'done',
      },
      { kind: 'file', path: 'src/a.ts' },
    ]);
  });

  it('builds gate, decide and human cards and a summary at the end', () => {
    const report = {
      gates: ['tests'],
      passed: false,
      checks: [
        { name: 'pnpm test', type: 'code', passed: false, skipped: false, evidence: '1 failing' },
      ],
    };
    const cards = reduceTimeline(state({ status: 'completed', pendingHumans: [] }), [
      run({ type: 'RunStarted' }),
      run({ type: 'NodeStarted', nodeId: 'qa' }),
      run({ type: 'GateFailed', nodeId: 'qa', report, rework: 'implement' }),
      run({ type: 'NodeStarted', nodeId: 'judge' }),
      run({ type: 'DecisionMade', nodeId: 'judge', choice: 'ship', confidence: 0.91 }),
      run({ type: 'NodeCompleted', nodeId: 'judge', output: {}, summary: '' }),
      run({ type: 'NodeStarted', nodeId: 'ship' }),
      run({ type: 'HumanRequested', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' }),
      run({ type: 'HumanResponded', nodeId: 'ship', approved: true, note: 'go' }),
      run({ type: 'NodeCompleted', nodeId: 'ship', output: {}, summary: '' }),
      rt('ship', { type: 'file_changed', path: 'a.ts' }),
      rt('ship', { type: 'file_changed', path: 'a.ts' }),
      run({ type: 'RunCompleted' }),
      end('completed'),
    ]);
    expect(cards.map((c) => c.kind)).toEqual(['gate', 'decide', 'human', 'summary']);
    const [gate, decide, human, summary] = cards;
    expect(gate).toMatchObject({
      passed: false,
      checks: [{ name: 'pnpm test', passed: false }],
      report: '1 failing',
    });
    expect(decide).toMatchObject({ choice: 'ship', confidence: 0.91 });
    expect(human).toMatchObject({
      prompt: 'Ship it?',
      pending: false,
      answer: { approved: true, note: 'go' },
    });
    expect(summary).toMatchObject({
      status: 'completed',
      costUsd: 0.002,
      files: ['a.ts'],
      branch: 'shibaox/run-r1',
    });
    if (summary?.kind === 'summary') expect(summary.durationMs).toBeGreaterThan(0);
  });

  it('marks a human card pending while the state still waits for it', () => {
    const cards = reduceTimeline(
      state({
        status: 'waiting_human',
        pendingHumans: [{ nodeId: 'ship', action: 'ship', prompt: 'Ship it?' }],
      }),
      [
        run({ type: 'NodeStarted', nodeId: 'ship' }),
        run({ type: 'HumanRequested', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' }),
      ],
    );
    expect(cards[0]).toMatchObject({ kind: 'human', pending: true });
  });

  it('shows node cards from state alone when there is no stream', () => {
    const nodes = Object.fromEntries(
      ['analyse', 'implement', 'qa', 'judge', 'ship'].map((id) => [
        id,
        { status: 'completed', attempts: 1, approvals: {} },
      ]),
    ) as RunState['nodes'];
    const cards = reduceTimeline(state({ status: 'completed', nodes }), []);
    expect(cards.map((c) => c.kind)).toEqual([
      'node',
      'node',
      'gate',
      'decide',
      'human',
      'summary',
    ]);
    expect(cards[0]).toMatchObject({ nodeId: 'analyse', attempts: 1, blocks: [] });
  });

  it('collapses the oldest cards past the limit', () => {
    const frames: Envelope[] = [];
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i < CARD_LIMIT + 100; i++) {
      nodes[`n${i}`] = { type: 'task', role: 'r' };
      frames.push(run({ type: 'NodeStarted', nodeId: `n${i}` }));
    }
    const s = state({ workflowSnapshot: { workflow: 'w', start: 'n0', nodes } as never });
    const cards = reduceTimeline(s, frames);
    expect(cards[0]).toEqual({ kind: 'earlier', count: 100 });
    expect(cards).toHaveLength(CARD_LIMIT + 1);
  });

  it('turns an adapter error into an error card', () => {
    const cards = reduceTimeline(state(), [
      run({ type: 'NodeStarted', nodeId: 'analyse' }),
      rt('analyse', { type: 'error', message: 'boom' }),
    ]);
    expect(cards.map((c) => c.kind)).toEqual(['node', 'error']);
    expect(cards[1]).toMatchObject({ message: 'boom', nodeId: 'analyse' });
  });
});

describe('summarizeInput', () => {
  it('prefers the path or command and trims JSON otherwise', () => {
    expect(summarizeInput({ file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizeInput({ command: 'git push origin main' })).toBe('git push origin main');
    expect(summarizeInput({ pattern: 'x', path: '.' })).toBe('{"pattern":"x","path":"."}');
    expect(summarizeInput({ text: 'a'.repeat(200) }).length).toBe(80);
    expect(summarizeInput(undefined)).toBe('');
  });
});
