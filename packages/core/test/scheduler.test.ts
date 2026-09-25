import { type RunEvent, WorkflowSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { readyNodes, replay } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';
const wf = WorkflowSchema.parse({
  workflow: 'w',
  start: 'a',
  nodes: {
    a: { type: 'task', role: 'r', next: 'p' },
    p: { type: 'parallel', branches: ['b1', 'b2'], join: 'g' },
    b1: { type: 'task', role: 'r' },
    b2: { type: 'code', command: 'true' },
    g: { type: 'gate', gates: ['t'], on_pass: 'd', on_fail: 'b1' },
    d: {
      type: 'decide',
      by: 'lead',
      options: ['ship', 'rework'],
      next: { ship: 'h', rework: 'a' },
    },
    h: { type: 'human', action: 'ok' },
  },
});
const created: RunEvent = {
  type: 'RunCreated',
  runId: 'r',
  at,
  workflow: 'w',
  input: {},
  workspace: '/w',
};
const started = (nodeId: string): RunEvent => ({ type: 'NodeStarted', runId: 'r', nodeId, at });
const done = (nodeId: string): RunEvent => ({
  type: 'NodeCompleted',
  runId: 'r',
  nodeId,
  at,
  output: null,
  summary: '',
});

describe('readyNodes', () => {
  it('starts with the start node', () => {
    expect(readyNodes(replay([created]), wf)).toEqual(['a']);
  });
  it('follows next after completion', () => {
    expect(readyNodes(replay([created, started('a'), done('a')]), wf)).toEqual(['p']);
  });
  it('parallel completion readies all branches, join waits for all', () => {
    const base = [created, started('a'), done('a'), started('p'), done('p')];
    expect(readyNodes(replay(base), wf).sort()).toEqual(['b1', 'b2']);
    expect(readyNodes(replay([...base, started('b1'), done('b1')]), wf)).toEqual(['b2']);
    expect(
      readyNodes(replay([...base, started('b1'), done('b1'), started('b2'), done('b2')]), wf),
    ).toEqual(['g']);
  });
  it('gate pass goes to on_pass; gate fail reruns the rework node', () => {
    const base = [
      created,
      started('a'),
      done('a'),
      started('p'),
      done('p'),
      started('b1'),
      done('b1'),
      started('b2'),
      done('b2'),
      started('g'),
    ];
    const report = { gates: ['t'], passed: true, checks: [] };
    expect(
      readyNodes(
        replay([...base, { type: 'GatePassed', runId: 'r', nodeId: 'g', at, report }]),
        wf,
      ),
    ).toEqual(['d']);
    expect(
      readyNodes(
        replay([
          ...base,
          {
            type: 'GateFailed',
            runId: 'r',
            nodeId: 'g',
            at,
            report: { ...report, passed: false },
            rework: 'b1',
          },
        ]),
        wf,
      ),
    ).toEqual(['b1']);
  });
  it('decide follows the chosen option', () => {
    const evs: RunEvent[] = [
      created,
      started('d'),
      { type: 'DecisionMade', runId: 'r', nodeId: 'd', at, choice: 'ship' },
    ];
    expect(readyNodes(replay(evs), wf)).toEqual(['h']);
  });
  it('returns nothing when the run is not running', () => {
    expect(readyNodes(replay([created, { type: 'RunCompleted', runId: 'r', at }]), wf)).toEqual([]);
  });
});
