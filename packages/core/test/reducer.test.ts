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

  it('gate failure resets the gate and the rework node to pending, keeping attempts', () => {
    const report = { gates: ['tests'], passed: false, checks: [] };
    const s = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at },
      { type: 'NodeCompleted', runId: 'r1', nodeId: 'a', at, output: null, summary: '' },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'g', at },
      { type: 'GateFailed', runId: 'r1', nodeId: 'g', at, report, rework: 'a' },
    ]);
    expect(s.nodes.a).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.nodes.g).toMatchObject({ status: 'pending', attempts: 1 });
    expect(s.lastGateReport).toEqual(report);
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
    expect(s1.pendingHuman).toEqual({ nodeId: 'h', action: 'ok', prompt: '?' });
    const s2 = replay([
      created,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'h', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'h', at, action: 'ok', prompt: '?' },
      { type: 'HumanResponded', runId: 'r1', nodeId: 'h', at, approved: true },
    ]);
    expect(s2.status).toBe('running');
    expect(s2.nodes.h?.status).toBe('completed');
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
