import type { RunState } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { reduceTimeline } from '../src/index.js';

const at = '2026-10-01T10:00:00.000Z';
const state = {
  runId: 'r1',
  workflow: 'hello-feature',
  status: 'completed',
  input: {},
  workspace: '/w',
  nodes: { judge: { status: 'completed', attempts: 1, choice: 'ship', decidedBy: 'jev' } },
  workflowSnapshot: {
    workflow: 'hello-feature',
    team: 't',
    start: 'judge',
    nodes: {
      judge: {
        type: 'decide',
        by: 'lead',
        question: 'Ready?',
        options: ['ship', 'rework'],
        next: { ship: 'ship', rework: 'implement' },
      },
    },
  },
  pendingApprovals: [],
  pendingHumans: [],
  spentUsd: 0,
} as unknown as RunState;

describe('the decide card', () => {
  it('carries the choice, the confidence and who decided', () => {
    const cards = reduceTimeline(state, [
      {
        kind: 'run',
        seq: 1,
        cursor: '1',
        event: {
          type: 'DecisionMade',
          runId: 'r1',
          nodeId: 'judge',
          at,
          choice: 'ship',
          confidence: 0.9,
          by: 'jev',
        },
      } as never,
    ]);
    const card = cards.find((c) => c.kind === 'decide');
    expect(card).toMatchObject({ kind: 'decide', choice: 'ship', confidence: 0.9, by: 'jev' });
  });

  it('a file the user saved (node "you") is a file of the run, never a phantom node card', () => {
    const cards = reduceTimeline(state, [
      {
        kind: 'runtime',
        seq: 2,
        cursor: '1:2',
        event: {
          runId: 'r1',
          nodeId: 'you',
          seq: 2,
          at,
          event: { type: 'file_changed', path: 'scripts/fib.js' },
        },
      } as never,
    ]);
    expect(cards.some((c) => c.kind === 'node' && c.nodeId === 'you')).toBe(false);
    expect(
      cards.some(
        (c) => 'files' in c && (c as { files: string[] }).files.includes('scripts/fib.js'),
      ),
    ).toBe(true);
  });
});
