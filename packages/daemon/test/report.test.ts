import type { RunState, StoredEvent } from '@wizardingcode/shibaox-core';
import { WorkflowSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { telegramReportText } from '../src/channels/telegram.js';
import { buildRunReport, chunkText } from '../src/runs/report.js';

const team = WorkflowSchema.parse({
  workflow: 'hello-feature',
  start: 'analyse',
  nodes: {
    analyse: { type: 'task', role: 'analyst', next: 'implement' },
    implement: { type: 'task', role: 'backend', next: 'ship' },
    ship: { type: 'human', action: 'approve-push' },
  },
});
const chat = WorkflowSchema.parse({
  workflow: 'chat',
  conversation: true,
  start: 'reply',
  nodes: { reply: { type: 'task', role: 'assistant' } },
});
const at = (s: number) => `2026-09-27T10:00:${String(s).padStart(2, '0')}.000Z`;
const events = (runId: string, workflow: string, secs: number): StoredEvent[] => [
  { seq: 1, type: 'RunCreated', runId, at: at(0), workflow, input: {}, workspace: '/w' },
  { seq: 2, type: 'RunStarted', runId, at: at(1) },
  { seq: 3, type: 'RunCompleted', runId, at: at(secs) },
];
const state = (over: Partial<RunState>): RunState =>
  ({
    runId: 'run-12345678',
    workflow: 'hello-feature',
    workflowSnapshot: team,
    input: { spec: 'add /health' },
    workspace: '/w',
    project: '/w',
    origin: 'schedule:s1',
    status: 'completed',
    nodes: {
      analyse: { status: 'completed', attempts: 1, summary: 'files: server.js', approvals: {} },
      implement: { status: 'completed', attempts: 2, summary: 'x'.repeat(300), approvals: {} },
      ship: { status: 'completed', attempts: 1, approvals: {} },
    },
    spentUsd: 0.1234,
    budgetWarned: false,
    pendingHumans: [],
    pendingApprovals: [],
    branch: 'shibaox/run-12345678',
    ...over,
  }) as RunState;

describe('buildRunReport', () => {
  it('summarises a team run: status, nodes with short summaries, cost, duration, branch', () => {
    const r = buildRunReport(state({}), events('run-12345678', 'hello-feature', 45), team, {
      notePath: '/vault/10-projects/w/runs/x.md',
    });
    expect(r).toMatchObject({
      runId: 'run-12345678',
      workflow: 'hello-feature',
      status: 'completed',
      origin: 'schedule:s1',
      spentUsd: 0.1234,
      durationMs: 45_000,
      branch: 'shibaox/run-12345678',
      notePath: '/vault/10-projects/w/runs/x.md',
    });
    expect(r.nodes.map((n) => n.id)).toEqual(['analyse', 'implement', 'ship']);
    expect(r.nodes[1]?.summary?.length).toBe(200);
    expect(r.reply).toBeUndefined();
    expect(r.needs).toBeUndefined();
  });
  it('a conversation run carries the orchestrator reply', () => {
    const s = state({
      workflow: 'chat',
      workflowSnapshot: chat,
      origin: 'telegram:42',
      nodes: {
        reply: {
          status: 'completed',
          attempts: 1,
          output: { text: 'Olá! Tudo bem.' },
          summary: 'Olá! Tudo bem.',
          approvals: {},
        },
      },
    });
    const r = buildRunReport(s, events('run-12345678', 'chat', 3), chat);
    expect(r.reply).toBe('Olá! Tudo bem.');
  });
  it('a failed run carries the error; a waiting run says what it needs; no snapshot still works', () => {
    const failed = buildRunReport(
      state({ status: 'failed', error: 'tests failed' }),
      events('run-12345678', 'hello-feature', 9),
      undefined,
    );
    expect(failed.error).toBe('tests failed');
    expect(failed.nodes.map((n) => n.id)).toEqual(['analyse', 'implement', 'ship']);
    const waiting = buildRunReport(
      state({
        status: 'waiting_human',
        pendingHumans: [{ nodeId: 'ship', action: 'approve-push', prompt: 'Approve the push?' }],
      }),
      events('run-12345678', 'hello-feature', 9),
      team,
    );
    expect(waiting.needs).toBe('Approve the push?');
  });
});

describe('telegramReportText', () => {
  it('renders a team run and a conversation reply, HTML-escaped', () => {
    const r = buildRunReport(state({}), events('run-12345678', 'hello-feature', 45), team, {
      notePath: '/v/note.md',
    });
    const text = telegramReportText(r);
    expect(text.startsWith('✓ hello-feature done · 3 nodes · $0.1234 · 45 s')).toBe(true);
    expect(text).toContain('branch shibaox/run-12345678');
    expect(text).toContain('analyse: files: server.js');
    expect(text).toContain('note: /v/note.md');
    const reply = telegramReportText({
      ...r,
      workflow: 'chat',
      reply: 'a <b> & c',
      nodes: [],
    });
    expect(reply).toBe('a <b> & c'); // escaped by the channel, per piece, when it is sent
    const failed = telegramReportText({ ...r, status: 'failed', error: 'boom' });
    expect(failed.startsWith('✗ hello-feature failed')).toBe(true);
    expect(failed).toContain('error: boom');
  });
  it('chunkText splits long text at line boundaries under the limit', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(120)}`);
    const chunks = chunkText(lines.join('\n'), 1000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join('\n')).toBe(lines.join('\n'));
    expect(chunkText('x'.repeat(2500), 1000).map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunkText(`${'x'.repeat(1000)}\n`, 1000)).toEqual(['x'.repeat(1000)]);
    expect(chunkText('', 1000)).toEqual([]);
  });
});
