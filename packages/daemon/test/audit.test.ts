import { replay, type StoredEvent } from '@wizardingcode/shibaox-core';
import type { RunEvent } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { buildAudit, renderAuditMarkdown } from '../src/runs/audit.js';
import type { RuntimeEnvelope } from '../src/runtime-buffer.js';

const t = (s: number) => `2026-09-30T10:00:${String(s).padStart(2, '0')}.000Z`;
const stored = (events: RunEvent[]): StoredEvent[] => events.map((e, i) => ({ ...e, seq: i + 1 }));

const snapshot = {
  workflow: 'land',
  team: 'eng',
  start: 'implement',
  nodes: {
    implement: { type: 'task', role: 'backend', instruction: 'do it', next: 'qa' },
    qa: { type: 'gate', gates: ['tests'], on_pass: 'judge', on_fail: 'implement', max_retries: 1 },
    judge: {
      type: 'decide',
      by: 'tl',
      question: 'ready?',
      options: ['ship', 'rework'],
      next: { ship: 'ship', rework: 'implement' },
    },
    ship: { type: 'human', action: 'approve-push', prompt: 'Land it?', next: 'commit' },
    commit: { type: 'git', action: 'commit' },
  },
} as never;

const events = stored([
  {
    type: 'RunCreated',
    runId: 'r1',
    at: t(0),
    workflow: 'land',
    input: { spec: 'Add x' },
    workspace: '/p/.shibaox/worktrees/r1',
    workflowSnapshot: snapshot,
    adapter: 'direct',
    workspaceMode: 'worktree',
    project: '/p',
    branch: 'shibaox/r1',
    baseBranch: 'main',
    orgRoot: '/o',
    origin: 'schedule:s1',
    model: 'openai/gpt-5',
  },
  { type: 'RunStarted', runId: 'r1', at: t(1) },
  { type: 'NodeStarted', runId: 'r1', nodeId: 'implement', at: t(2) },
  {
    type: 'ToolApprovalRequested',
    runId: 'r1',
    nodeId: 'implement',
    at: t(3),
    approvalId: 'a1',
    role: 'backend',
    tool: 'Bash',
    program: 'git',
    category: 'push',
    command: 'git push origin shibaox/r1',
    argvHash: 'h',
  },
  {
    type: 'ToolApprovalResolved',
    runId: 'r1',
    nodeId: 'implement',
    at: t(4),
    approvalId: 'a1',
    approved: true,
    note: 'fine',
    via: 'telegram',
  },
  {
    type: 'NodeCompleted',
    runId: 'r1',
    nodeId: 'implement',
    at: t(5),
    output: { did: 'x' },
    summary: 'wrote x',
    cost: { usd: 0.4, inputTokens: 10, outputTokens: 5 },
  },
  { type: 'NodeStarted', runId: 'r1', nodeId: 'qa', at: t(6) },
  {
    type: 'GatePassed',
    runId: 'r1',
    nodeId: 'qa',
    at: t(7),
    report: {
      gates: ['tests'],
      passed: true,
      checks: [{ name: 't', type: 'tests', passed: true, skipped: false, evidence: 'exit 0\nok' }],
    },
  },
  { type: 'NodeStarted', runId: 'r1', nodeId: 'judge', at: t(8) },
  {
    type: 'DecisionMade',
    runId: 'r1',
    nodeId: 'judge',
    at: t(9),
    choice: 'ship',
    confidence: 0.9,
    cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 },
  },
  { type: 'NodeStarted', runId: 'r1', nodeId: 'ship', at: t(10) },
  {
    type: 'HumanRequested',
    runId: 'r1',
    nodeId: 'ship',
    at: t(10),
    action: 'approve-push',
    prompt: 'Land it?',
  },
  { type: 'HumanResponded', runId: 'r1', nodeId: 'ship', at: t(20), approved: true, note: 'go' },
  {
    type: 'NodeCompleted',
    runId: 'r1',
    nodeId: 'ship',
    at: t(20),
    output: { approved: true },
    summary: '',
  },
  { type: 'NodeStarted', runId: 'r1', nodeId: 'commit', at: t(21) },
  {
    type: 'NodeCompleted',
    runId: 'r1',
    nodeId: 'commit',
    at: t(22),
    output: { committed: true, sha: 'abc1234def' },
    summary: 'committed abc1234',
  },
  { type: 'RunCompleted', runId: 'r1', at: t(23) },
]);

const runtime: RuntimeEnvelope[] = [
  { runId: 'r1', nodeId: 'implement', seq: 1, at: t(2), event: { type: 'started' } },
  {
    runId: 'r1',
    nodeId: 'implement',
    seq: 2,
    at: t(2),
    event: { type: 'tool_use', id: 'u1', name: 'read_file', input: { path: 'src/a.ts' } },
  },
  {
    runId: 'r1',
    nodeId: 'implement',
    seq: 3,
    at: t(3),
    event: { type: 'tool_result', id: 'u1', name: 'read_file', output: 'contents', durationMs: 7 },
  },
  { runId: 'r1', nodeId: 'implement', seq: 4, at: t(3), event: { type: 'text', text: 'Done.' } },
];

describe('the audit of a run', () => {
  it('gathers request, nodes with attempts and tool calls, gates, decisions, approvals, git and cost', () => {
    const doc = buildAudit(replay(events), events, runtime);
    expect(doc).toMatchObject({
      runId: 'r1',
      workflow: 'land',
      status: 'completed',
      request: {
        input: { spec: 'Add x' },
        project: '/p',
        branch: 'shibaox/r1',
        baseBranch: 'main',
        orgRoot: '/o',
        adapter: 'direct',
        model: 'openai/gpt-5',
        origin: 'schedule:s1',
      },
      createdAt: t(0),
      endedAt: t(23),
      durationMs: 23_000,
      cost: { totalUsd: 0.5, byNode: { implement: 0.4, judge: 0.1 } },
    });
    const implement = doc.nodes.find((n) => n.nodeId === 'implement');
    expect(implement).toMatchObject({
      type: 'task',
      role: 'backend',
      status: 'completed',
      attempts: 1,
      startedAt: t(2),
      endedAt: t(5),
      summary: 'wrote x',
      costUsd: 0.4,
    });
    expect(implement?.toolCalls).toEqual([
      { name: 'read_file', input: '{"path":"src/a.ts"}', durationMs: 7, at: t(2) },
    ]);
    expect(doc.nodes.map((n) => n.nodeId)).toEqual(['implement', 'qa', 'judge', 'ship', 'commit']);
    expect(doc.gates).toEqual([
      {
        nodeId: 'qa',
        at: t(7),
        passed: true,
        checks: [
          { name: 't', type: 'tests', passed: true, skipped: false, evidence: 'exit 0\nok' },
        ],
      },
    ]);
    expect(doc.decisions).toEqual([{ nodeId: 'judge', at: t(9), choice: 'ship', confidence: 0.9 }]);
    expect(doc.approvals).toEqual([
      {
        kind: 'tool',
        nodeId: 'implement',
        askedAt: t(3),
        answeredAt: t(4),
        what: 'git push origin shibaox/r1',
        approved: true,
        via: 'telegram',
        note: 'fine',
      },
      {
        kind: 'human',
        nodeId: 'ship',
        askedAt: t(10),
        answeredAt: t(20),
        what: 'Land it?',
        approved: true,
        note: 'go',
      },
    ]);
    expect(doc.git).toEqual([
      {
        nodeId: 'commit',
        action: 'commit',
        at: t(22),
        output: { committed: true, sha: 'abc1234def' },
      },
    ]);
  });

  it('renders as Markdown a person can read and file', () => {
    const md = renderAuditMarkdown(buildAudit(replay(events), events, runtime));
    expect(md).toContain('# Run r1 · land · completed');
    expect(md).toContain('Add x');
    expect(md).toContain('openai/gpt-5');
    expect(md).toContain('read_file');
    expect(md).toContain('7 ms');
    expect(md).toContain('git push origin shibaox/r1');
    expect(md).toContain('approved via telegram');
    expect(md).toContain('ship (0.90)');
    expect(md).toContain('abc1234def');
    expect(md).toContain('$0.5000');
  });

  it('a run without snapshot or runtime events still audits', () => {
    const bare = stored([
      { type: 'RunCreated', runId: 'r2', at: t(0), workflow: 'w', input: {}, workspace: '/w' },
      { type: 'RunStarted', runId: 'r2', at: t(1) },
      { type: 'NodeStarted', runId: 'r2', nodeId: 'a', at: t(2) },
      { type: 'NodeFailed', runId: 'r2', nodeId: 'a', at: t(3), error: 'boom' },
    ]);
    const doc = buildAudit(replay(bare), bare, []);
    expect(doc.nodes[0]).toMatchObject({
      nodeId: 'a',
      status: 'failed',
      error: 'boom',
      attempts: 1,
    });
    expect(doc.endedAt).toBe(t(3)); // a failed run ended at its failure
    expect(renderAuditMarkdown(doc)).toContain('boom');
  });
});
