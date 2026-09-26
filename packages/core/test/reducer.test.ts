import type { RunEvent } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { replay } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';
const created: RunEvent = {
  type: 'RunCreated',
  runId: 'r1',
  at,
  workflow: 'hello',
  input: { spec: 'x' },
  budgetUsd: 1,
  workspace: '/tmp/w',
};

describe('replay', () => {
  it('starts running with no nodes', () => {
    const s = replay([created]);
    expect(s.status).toBe('running');
    expect(s.nodes).toEqual({});
    expect(s.spentUsd).toBe(0);
    expect(s.pendingHumans).toEqual([]);
  });

  it('tracks node lifecycle, attempts and cost', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      {
        type: 'NodeCompleted',
        runId: 'r1',
        nodeId: 'a',
        at,
        output: { ok: 1 },
        summary: 'done',
        cost: { usd: 0.25, inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(s.nodes.a).toMatchObject({ status: 'completed', attempts: 1, output: { ok: 1 } });
    expect(s.spentUsd).toBeCloseTo(0.25);
  });

  it('gate failure marks the gate gate_failed and leaves the rework node untouched', () => {
    const report = { gates: ['tests'], passed: false, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      { type: 'NodeCompleted', runId: 'r1', nodeId: 'a', at, output: null, summary: '' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      { type: 'GateFailed', runId: 'r1', nodeId: 'g', at, report, rework: 'a' },
    ]);
    expect(s.nodes.a).toMatchObject({
      status: 'completed',
      attempts: 1,
      startedIdx: 1,
      finishedIdx: 2,
    });
    expect(s.nodes.g).toMatchObject({
      status: 'gate_failed',
      attempts: 1,
      report,
      startedIdx: 3,
      finishedIdx: 4,
    });
    expect(s.lastGateReport).toEqual(report);
  });

  it('records startedIdx and finishedIdx as event log indexes for every finishing event', () => {
    const report = { gates: ['tests'], passed: true, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      { type: 'GatePassed', runId: 'r1', nodeId: 'g', at, report },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'd', at },
      { type: 'DecisionMade', runId: 'r1', nodeId: 'd', at, choice: 'x' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h', at, approved: true },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      { type: 'NodeFailed', runId: 'r1', nodeId: 'g', at, error: 'x' },
    ]);
    expect(s.nodes.d).toMatchObject({ startedIdx: 3, finishedIdx: 4 });
    expect(s.nodes.h).toMatchObject({ startedIdx: 5, finishedIdx: 7 });
    expect(s.nodes.g).toMatchObject({
      status: 'failed',
      attempts: 2,
      startedIdx: 8,
      finishedIdx: 9,
    });
  });

  it('gate failure with a cost still adds to spentUsd', () => {
    const report = { gates: ['tests'], passed: false, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      { type: 'NodeCompleted', runId: 'r1', nodeId: 'a', at, output: null, summary: '' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      {
        type: 'GateFailed',
        runId: 'r1',
        nodeId: 'g',
        at,
        report,
        rework: 'a',
        cost: { usd: 0.4, inputTokens: 2, outputTokens: 2 },
      },
    ]);
    expect(s.spentUsd).toBeCloseTo(0.4);
  });

  it('gate passed marks the node passed, stores the report, and adds cost', () => {
    const report = { gates: ['tests'], passed: true, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      {
        type: 'GatePassed',
        runId: 'r1',
        nodeId: 'g',
        at,
        report,
        cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(s.nodes.g).toMatchObject({ status: 'passed', report });
    expect(s.lastGateReport).toEqual(report);
    expect(s.spentUsd).toBeCloseTo(0.1);
  });

  it('decision made completes the node with choice, output and cost', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'd', at },
      {
        type: 'DecisionMade',
        runId: 'r1',
        nodeId: 'd',
        at,
        choice: 'yes',
        confidence: 0.9,
        cost: { usd: 0.05, inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(s.nodes.d).toMatchObject({
      status: 'completed',
      choice: 'yes',
      output: { choice: 'yes', confidence: 0.9 },
    });
    expect(s.spentUsd).toBeCloseTo(0.05);
  });

  it('human request pauses the run; response resumes it', () => {
    const s1 = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' },
    ]);
    expect(s1.status).toBe('waiting_human');
    expect(s1.pendingHumans).toEqual([{ nodeId: 'h', action: 'ok', prompt: '?' }]);
    const s2 = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h', at, approved: true },
    ]);
    expect(s2.status).toBe('running');
    expect(s2.pendingHumans).toEqual([]);
    expect(s2.nodes.h?.status).toBe('completed');
  });

  it('two human requests build a two-item pendingHumans; the run waits until both respond', () => {
    const base: RunEvent[] = [
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h1', at },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h2', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h1', at, action: 'a1', prompt: 'p1' },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h2', at, action: 'a2', prompt: 'p2' },
    ];
    const s1 = replay(base);
    expect(s1.status).toBe('waiting_human');
    expect(s1.pendingHumans).toEqual([
      { nodeId: 'h1', action: 'a1', prompt: 'p1' },
      { nodeId: 'h2', action: 'a2', prompt: 'p2' },
    ]);
    const s2 = replay([
      ...base,
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h1', at, approved: true },
    ]);
    expect(s2.status).toBe('waiting_human');
    expect(s2.pendingHumans).toEqual([{ nodeId: 'h2', action: 'a2', prompt: 'p2' }]);
    expect(s2.nodes.h1).toMatchObject({ status: 'completed', finishedIdx: 5 });
    const s3 = replay([
      ...base,
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h1', at, approved: true },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h2', at, approved: true },
    ]);
    expect(s3.status).toBe('running');
    expect(s3.pendingHumans).toEqual([]);
  });

  it('a rejected human response cancels the run with the reason', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h1', at },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h2', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h1', at, action: 'a1', prompt: 'p1' },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h2', at, action: 'a2', prompt: 'p2' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h1', at, approved: false, note: 'nope' },
    ]);
    expect(s.status).toBe('cancelled');
    expect(s.error).toBe('rejected by human at h1: nope');
    expect(s.pendingHumans).toEqual([]);
    expect(s.nodes.h1?.status).toBe('completed');
    const noNote = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'a', prompt: 'p' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h', at, approved: false },
    ]);
    expect(noNote.error).toBe('rejected by human at h');
  });

  it('budget exceeded pauses; RunResumed raises the limit and resumes', () => {
    const s = replay([
      created,
      { type: 'BudgetExceeded', runId: 'r1', at, spentUsd: 1.2, limitUsd: 1 },
    ]);
    expect(s.status).toBe('paused_budget');
    const s2 = replay([
      created,
      { type: 'BudgetExceeded', runId: 'r1', at, spentUsd: 1.2, limitUsd: 1 },
      { type: 'RunResumed', runId: 'r1', at, budgetUsd: 5 },
    ]);
    expect(s2.status).toBe('running');
    expect(s2.budgetUsd).toBe(5);
  });

  it('budget warning flags budgetWarned without pausing the run; RunResumed clears it', () => {
    const s = replay([
      created,
      { type: 'BudgetWarning', runId: 'r1', at, spentUsd: 0.9, limitUsd: 1 },
    ]);
    expect(s.budgetWarned).toBe(true);
    expect(s.status).toBe('running');
    const s2 = replay([
      created,
      { type: 'BudgetWarning', runId: 'r1', at, spentUsd: 0.9, limitUsd: 1 },
      { type: 'RunResumed', runId: 'r1', at },
    ]);
    expect(s2.budgetWarned).toBe(false);
    expect(s2.status).toBe('running');
  });

  it('sums the cost carried by NodeFailed', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      {
        type: 'NodeFailed',
        runId: 'r1',
        nodeId: 'a',
        at,
        error: 'model stopped',
        cost: { usd: 0.25, inputTokens: 10, outputTokens: 5 },
      },
    ]);
    expect(s.status).toBe('failed');
    expect(s.spentUsd).toBeCloseTo(0.25);
  });

  it('keeps a failed status sticky against a sibling human request/response racing in after it', () => {
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'bad', at },
      { type: 'NodeFailed', runId: 'r1', nodeId: 'bad', at, error: 'boom' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'ask', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'ask', at, action: 'ok', prompt: '?' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'ask', at, approved: true },
    ]);
    expect(s.status).toBe('failed');
    expect(s.error).toBe('bad: boom');
    expect(s.pendingHumans).toEqual([]);
    expect(s.nodes.ask?.status).toBe('completed');
  });

  it('keeps a cancelled status sticky against a sibling NodeFailed racing in after it', () => {
    const s = replay([
      created,
      { type: 'RunCancelled', runId: 'r1', at, reason: 'rejected by human at ship' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'bad', at },
      { type: 'NodeFailed', runId: 'r1', nodeId: 'bad', at, error: 'boom' },
    ]);
    expect(s.status).toBe('cancelled');
    expect(s.error).toBe('rejected by human at ship');
    expect(s.nodes.bad?.status).toBe('failed');
  });

  it('terminal events set final status', () => {
    expect(replay([created, { type: 'RunCompleted', runId: 'r1', at }]).status).toBe('completed');
    expect(replay([created, { type: 'RunCancelled', runId: 'r1', at, reason: 'x' }]).status).toBe(
      'cancelled',
    );
    expect(
      replay([
        created,
        { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
        { type: 'NodeFailed', runId: 'r1', nodeId: 'a', at, error: 'boom' },
      ]).status,
    ).toBe('failed');
  });
});
