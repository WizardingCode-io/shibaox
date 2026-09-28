import { type RunEvent, WorkflowSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { isStalled, readyNodes, replay } from '../src/index.js';

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
    expect(readyNodes(replay([created, { type: 'RunStarted', runId: 'r', at }]), wf)).toEqual([
      'a',
    ]);
    expect(readyNodes(replay([created]), wf)).toEqual([]);
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
  it('a join gate reworking one branch re-runs only that branch, then the gate', () => {
    const joinWf = WorkflowSchema.parse({
      workflow: 'jg',
      start: 'p',
      nodes: {
        p: { type: 'parallel', branches: ['b1', 'b2'], join: 'g' },
        b1: { type: 'task', role: 'r' },
        b2: { type: 'task', role: 'r' },
        g: { type: 'gate', gates: ['t'], on_pass: 'h', on_fail: 'b1' },
        h: { type: 'human', action: 'ok' },
      },
    });
    const report = { gates: ['t'], passed: false, checks: [] };
    const failed: RunEvent[] = [
      created,
      started('p'),
      done('p'),
      started('b1'),
      done('b1'),
      started('b2'),
      done('b2'),
      started('g'),
      { type: 'GateFailed', runId: 'r', nodeId: 'g', at, report, rework: 'b1' },
    ];
    expect(readyNodes(replay(failed), joinWf)).toEqual(['b1']);
    expect(readyNodes(replay([...failed, started('b1')]), joinWf)).toEqual([]);
    const reworked = [...failed, started('b1'), done('b1')];
    expect(readyNodes(replay(reworked), joinWf)).toEqual(['g']);
    const s = replay(reworked);
    expect(s.nodes.b2).toMatchObject({ attempts: 1, startedIdx: 5, finishedIdx: 6 });
  });

  it('gate rework to start node makes it ready again', () => {
    const simpleWf = WorkflowSchema.parse({
      workflow: 'w2',
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'r', next: 'g' },
        g: { type: 'gate', gates: ['t'], on_pass: 'done', on_fail: 'a' },
        done: { type: 'human', action: 'ok' },
      },
    });
    const createdSimple: RunEvent = {
      type: 'RunCreated',
      runId: 'r2',
      at,
      workflow: 'w2',
      input: {},
      workspace: '/w',
    };
    const startedSimple = (nodeId: string): RunEvent => ({
      type: 'NodeStarted',
      runId: 'r2',
      nodeId,
      at,
    });
    const doneSimple = (nodeId: string): RunEvent => ({
      type: 'NodeCompleted',
      runId: 'r2',
      nodeId,
      at,
      output: null,
      summary: '',
    });
    const base = [createdSimple, startedSimple('a'), doneSimple('a'), startedSimple('g')];
    const report = { gates: ['t'], passed: false, checks: [] };
    expect(
      readyNodes(
        replay([
          ...base,
          {
            type: 'GateFailed',
            runId: 'r2',
            nodeId: 'g',
            at,
            report,
            rework: 'a',
          },
        ]),
        simpleWf,
      ),
    ).toEqual(['a']);
  });

  it('decide follows the chosen option', () => {
    const evs: RunEvent[] = [
      created,
      started('d'),
      { type: 'DecisionMade', runId: 'r', nodeId: 'd', at, choice: 'ship' },
    ];
    // the start node was never started, so it is ready alongside the chosen target
    expect(readyNodes(replay(evs), wf)).toEqual(['a', 'h']);
  });
  it('does not re-ready a start node that has already started', () => {
    expect(readyNodes(replay([created, started('a')]), wf)).toEqual([]);
  });
  it('treats an interrupted node (pending, no startedIdx) as never started', () => {
    // what the engine's markInterrupted produces for a node running at crash time
    const s = replay([created, started('a'), done('a'), started('p')]);
    const interrupted = {
      ...s,
      nodes: { ...s.nodes, p: { status: 'pending' as const, attempts: 1 } },
    };
    expect(readyNodes(interrupted, wf)).toEqual(['p']);
    const startInterrupted = {
      ...replay([created, started('a')]),
      nodes: { a: { status: 'pending' as const, attempts: 1 } },
    };
    expect(readyNodes(startInterrupted, wf)).toEqual(['a']);
  });
  it('a gate that failed is not re-run while its rework is running', () => {
    const report = { gates: ['t'], passed: false, checks: [] };
    const evs: RunEvent[] = [
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
      { type: 'GateFailed', runId: 'r', nodeId: 'g', at, report, rework: 'b1' },
      started('b1'),
    ];
    expect(readyNodes(replay(evs), wf)).toEqual([]);
  });
  it('returns nothing when the run is not running', () => {
    expect(readyNodes(replay([created, { type: 'RunCompleted', runId: 'r', at }]), wf)).toEqual([]);
  });

  it('decide loop-back re-readies an already finished node, then the decide again', () => {
    const loopWf = WorkflowSchema.parse({
      workflow: 'loop',
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'r', next: 'd' },
        d: {
          type: 'decide',
          by: 'lead',
          options: ['again', 'stop'],
          next: { again: 'a', stop: 'h' },
        },
        h: { type: 'human', action: 'ok' },
      },
    });
    const decided: RunEvent[] = [
      created,
      started('a'),
      done('a'),
      started('d'),
      { type: 'DecisionMade', runId: 'r', nodeId: 'd', at, choice: 'again' },
    ];
    expect(readyNodes(replay(decided), loopWf)).toEqual(['a']);
    expect(readyNodes(replay([...decided, started('a')]), loopWf)).toEqual([]);
    expect(readyNodes(replay([...decided, started('a'), done('a')]), loopWf)).toEqual(['d']);
  });
  it('gate rework to a grandparent re-runs the chain in order, not the gate concurrently', () => {
    const chainWf = WorkflowSchema.parse({
      workflow: 'chain',
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'r', next: 'b' },
        b: { type: 'task', role: 'r', next: 'g' },
        g: { type: 'gate', gates: ['t'], on_pass: 'h', on_fail: 'a' },
        h: { type: 'human', action: 'ok' },
      },
    });
    const report = { gates: ['t'], passed: false, checks: [] };
    const failed: RunEvent[] = [
      created,
      started('a'),
      done('a'),
      started('b'),
      done('b'),
      started('g'),
      { type: 'GateFailed', runId: 'r', nodeId: 'g', at, report, rework: 'a' },
    ];
    expect(readyNodes(replay(failed), chainWf)).toEqual(['a']);
    const aAgain = [...failed, started('a'), done('a')];
    expect(readyNodes(replay(aAgain), chainWf)).toEqual(['b']);
    const bAgain = [...aAgain, started('b'), done('b')];
    expect(readyNodes(replay(bAgain), chainWf)).toEqual(['g']);
  });
  it('a re-entered parallel re-runs its branches and the join waits for the new round', () => {
    const parWf = WorkflowSchema.parse({
      workflow: 'par',
      start: 'p',
      nodes: {
        p: { type: 'parallel', branches: ['b1', 'b2'], join: 'd' },
        b1: { type: 'task', role: 'r' },
        b2: { type: 'task', role: 'r' },
        d: {
          type: 'decide',
          by: 'lead',
          options: ['again', 'stop'],
          next: { again: 'p', stop: 'h' },
        },
        h: { type: 'human', action: 'ok' },
      },
    });
    const round1: RunEvent[] = [
      created,
      started('p'),
      done('p'),
      started('b1'),
      done('b1'),
      started('b2'),
      done('b2'),
      started('d'),
      { type: 'DecisionMade', runId: 'r', nodeId: 'd', at, choice: 'again' },
    ];
    expect(readyNodes(replay(round1), parWf)).toEqual(['p']);
    const p2 = [...round1, started('p'), done('p')];
    expect(readyNodes(replay(p2), parWf)).toEqual(['b1', 'b2']);
    expect(readyNodes(replay([...p2, started('b1'), done('b1')]), parWf)).toEqual(['b2']);
    expect(
      readyNodes(replay([...p2, started('b1'), done('b1'), started('b2'), done('b2')]), parWf),
    ).toEqual(['d']);
  });
});

describe('isStalled', () => {
  it('reports a pending node with no live path when nothing is ready', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'w',
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'r', next: 'b' },
        b: { type: 'task', role: 'r' },
      },
    });
    const s = replay([created, started('a'), done('a'), started('b')]);
    const interrupted = {
      ...s,
      nodes: { ...s.nodes, b: { ...s.nodes.b!, status: 'pending' as const, startedIdx: 5 } },
    };
    expect(readyNodes(interrupted, wf)).toEqual([]);
    expect(isStalled(interrupted, wf)).toEqual({
      stalled: true,
      reason: 'node "b" is pending but no predecessor finished after it started',
    });
    expect(
      isStalled(replay([created, started('a'), done('a'), started('b'), done('b')]), wf),
    ).toEqual({
      stalled: false,
    });
  });
});
