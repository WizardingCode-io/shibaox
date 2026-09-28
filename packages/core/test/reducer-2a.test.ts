import type { RunEvent } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { replay } from '../src/run/reducer.js';

const at = '2026-09-26T00:00:00.000Z';
const created: RunEvent = {
  type: 'RunCreated',
  runId: 'r1',
  at,
  workflow: 'wf',
  input: {},
  workspace: '/w',
  orgRoot: '/org',
};
const started: RunEvent = { type: 'RunStarted', runId: 'r1', at };
const implStarted: RunEvent = { type: 'NodeStarted', runId: 'r1', nodeId: 'impl', at };
const approvalReq: RunEvent = {
  type: 'ToolApprovalRequested',
  runId: 'r1',
  nodeId: 'impl',
  at,
  approvalId: 'a1',
  role: 'backend',
  tool: 'Bash',
  program: 'git',
  category: 'push',
  command: 'git push origin main',
  argvHash: 'h1',
};

describe('reducer phase 2A', () => {
  it('RunCreated is queued until RunStarted; a legacy NodeStarted also starts it', () => {
    expect(replay([created]).status).toBe('queued');
    expect(replay([created, started]).status).toBe('running');
    expect(replay([created, { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at }]).status).toBe(
      'running',
    );
    expect(replay([created]).orgRoot).toBe('/org');
  });

  it('tool approval blocks the run and resolves back to running, recording it on the node', () => {
    const base = [created, started, implStarted];
    const waiting = replay([...base, approvalReq]);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.pendingApprovals).toEqual([
      {
        approvalId: 'a1',
        runId: 'r1',
        nodeId: 'impl',
        role: 'backend',
        tool: 'Bash',
        program: 'git',
        category: 'push',
        command: 'git push origin main',
        argvHash: 'h1',
        at,
      },
    ]);
    const resolved = replay([
      ...base,
      approvalReq,
      {
        type: 'ToolApprovalResolved',
        runId: 'r1',
        nodeId: 'impl',
        at,
        approvalId: 'a1',
        approved: true,
        via: 'cli',
      },
    ]);
    expect(resolved.status).toBe('running');
    expect(resolved.pendingApprovals).toEqual([]);
    expect(resolved.nodes.impl?.approvals).toEqual({
      a1: { argvHash: 'h1', command: 'git push origin main', approved: true, note: undefined },
    });
  });

  it('SessionStarted records the session id; NodeSuspended makes the node re-runnable and keeps waiting_approval', () => {
    const s = replay([
      created,
      started,
      implStarted,
      {
        type: 'SessionStarted',
        runId: 'r1',
        nodeId: 'impl',
        at,
        runtime: 'claude-code',
        sessionId: 'sess-1',
      },
      approvalReq,
      {
        type: 'NodeSuspended',
        runId: 'r1',
        nodeId: 'impl',
        at,
        sessionId: 'sess-1',
        approvalId: 'a1',
        cost: { usd: 0.25, inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(s.status).toBe('waiting_approval');
    expect(s.nodes.impl).toMatchObject({ status: 'pending', sessionId: 'sess-1', attempts: 1 });
    expect(s.nodes.impl?.startedIdx).toBeUndefined();
    expect(s.spentUsd).toBeCloseTo(0.25);
  });

  it('resolving while a human is also pending goes back to waiting_human', () => {
    const s = replay([
      created,
      started,
      { type: 'HumanRequested', runId: 'r1', nodeId: 'ship', at, action: 'ship', prompt: 'ok?' },
      approvalReq,
      {
        type: 'ToolApprovalResolved',
        runId: 'r1',
        nodeId: 'impl',
        at,
        approvalId: 'a1',
        approved: false,
        note: 'no',
        via: 'telegram',
      },
    ]);
    expect(s.status).toBe('waiting_human');
  });

  it('a denied approval stays recorded so the adapter can deny without asking again', () => {
    const s = replay([
      created,
      started,
      approvalReq,
      {
        type: 'ToolApprovalResolved',
        runId: 'r1',
        nodeId: 'impl',
        at,
        approvalId: 'a1',
        approved: false,
        via: 'api',
      },
    ]);
    expect(s.nodes.impl?.approvals.a1?.approved).toBe(false);
  });

  it('a budget pause drops the session id so the task restarts fresh', () => {
    const s = replay([
      created,
      started,
      implStarted,
      {
        type: 'SessionStarted',
        runId: 'r1',
        nodeId: 'impl',
        at,
        runtime: 'claude-code',
        sessionId: 'sess-1',
      },
      { type: 'BudgetExceeded', runId: 'r1', at, spentUsd: 6, limitUsd: 5, nodeId: 'impl' },
    ]);
    expect(s.nodes.impl?.sessionId).toBeUndefined();
    expect(s.nodes.impl?.status).toBe('pending');
  });

  it('a terminal run clears pending approvals', () => {
    const s = replay([
      created,
      started,
      approvalReq,
      { type: 'RunCancelled', runId: 'r1', at, reason: 'stop' },
    ]);
    expect(s.pendingApprovals).toEqual([]);
    expect(s.status).toBe('cancelled');
  });
});
