import type { Envelope } from '@shibaox/daemon';
import { describe, expect, it } from 'vitest';
import { AppStore } from '../src/store.js';
import { applyFrame, RUN_EVENT_REFRESH, type StreamLine, summarizeInput } from '../src/stream.js';

const runtime = (event: Record<string, unknown>, nodeId = 'impl', seq = 1): Envelope =>
  ({
    kind: 'runtime',
    seq,
    cursor: `0:${seq}`,
    event: { runId: 'r', nodeId, seq, at: 'x', event },
  }) as unknown as Envelope;
const runEvent = (event: Record<string, unknown>, seq = 1): Envelope =>
  ({
    kind: 'run',
    seq,
    cursor: `${seq}:0`,
    event: { runId: 'r', at: 'x', seq, ...event },
  }) as never;

describe('applyFrame', () => {
  it('collapses tool_use and tool_result into one line with the duration', () => {
    let lines: StreamLine[] = [];
    lines = applyFrame(
      lines,
      runtime({ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }),
    );
    expect(lines).toEqual([
      {
        kind: 'tool',
        nodeId: 'impl',
        depth: 0,
        text: 'Read',
        tool: { id: 't1', name: 'Read', summary: '{"file_path":"a.ts"}', status: 'running' },
      },
    ]);
    lines = applyFrame(
      lines,
      runtime({ type: 'tool_result', id: 't1', name: 'Read', output: 'ok', durationMs: 40 }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tool).toMatchObject({ status: 'done', durationMs: 40 });
  });

  it('marks an error result and unknown ids as their own line', () => {
    let lines = applyFrame([], runtime({ type: 'tool_use', id: 't1', name: 'Bash', input: {} }));
    lines = applyFrame(
      lines,
      runtime({ type: 'tool_result', id: 't1', name: 'Bash', output: { error: 'boom' } }),
    );
    expect(lines[0]?.tool?.status).toBe('error');
    lines = applyFrame(
      lines,
      runtime({ type: 'tool_result', id: 'zz', name: 'Bash', output: 'x', durationMs: 2 }),
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]?.tool).toMatchObject({ status: 'done', durationMs: 2 });
  });

  it('indents subagent lines and splits multi-line text', () => {
    let lines = applyFrame(
      [],
      runtime({ type: 'text', text: 'one\ntwo', parentToolUseId: 'agent-1' }),
    );
    expect(lines.map((l) => [l.depth, l.text])).toEqual([
      [1, 'one'],
      [1, 'two'],
    ]);
    lines = applyFrame(
      lines,
      runtime({ type: 'session', runtime: 'claude-code', sessionId: 's1' }),
    );
    expect(lines.at(-1)).toMatchObject({ kind: 'session', text: 'session s1' });
  });

  it('a NodeStarted frame inserts a separator; ToolApprovalRequested marks the last Bash tool', () => {
    let lines = applyFrame([], runEvent({ type: 'NodeStarted', nodeId: 'impl' }));
    expect(lines[0]).toMatchObject({ kind: 'event', text: '── impl ──' });
    lines = applyFrame(
      lines,
      runtime({ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git push' } }),
    );
    lines = applyFrame(lines, runtime({ type: 'tool_use', id: 'r1', name: 'Read', input: {} }));
    lines = applyFrame(
      lines,
      runEvent({
        type: 'ToolApprovalRequested',
        nodeId: 'impl',
        approvalId: 'a1',
        command: 'git push',
      }),
    );
    expect(lines[1]?.tool?.status).toBe('approval');
    expect(lines[2]?.tool?.status).toBe('running');
    // other run events add nothing
    expect(applyFrame(lines, runEvent({ type: 'BudgetWarning' }))).toBe(lines);
  });

  it('does not mutate its input', () => {
    const before: StreamLine[] = [{ kind: 'text', nodeId: 'x', depth: 0, text: 'a' }];
    const copy = structuredClone(before);
    applyFrame(before, runtime({ type: 'text', text: 'b' }));
    expect(before).toEqual(copy);
  });

  it('summarizeInput caps at 80 chars and RUN_EVENT_REFRESH lists the refreshing events', () => {
    expect(summarizeInput({ a: 'x'.repeat(200) })).toHaveLength(80);
    expect(summarizeInput(undefined)).toBe('');
    for (const t of [
      'NodeStarted',
      'NodeCompleted',
      'NodeFailed',
      'GatePassed',
      'GateFailed',
      'HumanRequested',
      'ToolApprovalRequested',
      'NodeSuspended',
      'BudgetExceeded',
      'RunCompleted',
      'RunCancelled',
    ])
      expect(RUN_EVENT_REFRESH.has(t)).toBe(true);
    expect(RUN_EVENT_REFRESH.has('BudgetWarning')).toBe(false);
  });

  it('stream keeps the last 2000 lines', () => {
    const store = new AppStore();
    let lines: StreamLine[] = [];
    for (let i = 0; i < 2100; i++)
      lines = applyFrame(lines, runtime({ type: 'text', text: `t${i}` }, 'impl', i));
    store.pushLines('r', lines);
    expect(store.get().streams.r).toHaveLength(2000);
    expect(store.get().streams.r?.at(-1)?.text).toBe('t2099');
    expect(store.get().streams.r?.[0]?.text).toBe('t100');
  });
});
