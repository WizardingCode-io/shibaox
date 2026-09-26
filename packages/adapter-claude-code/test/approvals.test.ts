import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  type ApprovalHandler,
  type ApprovalRequest,
  argvHash,
  type RuntimeEvent,
  type TaskJob,
} from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';
import { fakeQuery, msg } from '../src/testing/fake-query.js';

const role = (o: { tools: string[]; approval_required?: string[] }) =>
  RoleSchema.parse({
    role: 'backend',
    tools: o.tools,
    permissions: { approval_required: o.approval_required ?? [] },
  });
const pushRole = role({ tools: ['git'], approval_required: ['push'] });

const job = (extra: Partial<TaskJob> = {}): TaskJob => ({
  runId: 'r',
  nodeId: 'implement',
  role: pushRole,
  instruction: 'push it',
  input: {},
  workspace: '/tmp/ws',
  context: { previousOutputs: {} },
  approvedCommands: {},
  ...extra,
});

async function run(adapter: ClaudeCodeAdapter, extra: Partial<TaskJob> = {}) {
  const events: RuntimeEvent[] = [];
  const ctx = { signal: new AbortController().signal, log: () => {} };
  for await (const e of adapter.run(job(extra), ctx)) events.push(e);
  return events;
}

function handler(answer: (r: ApprovalRequest) => Promise<unknown>) {
  const requests: ApprovalRequest[] = [];
  const h: ApprovalHandler = {
    request: async (r) => {
      requests.push(r);
      return (await answer(r)) as never;
    },
  };
  return Object.assign(h, { requests });
}
const toolCtx = { signal: new AbortController().signal, suggestions: [] };
const canUse = (options: { canUseTool?: unknown }) => {
  const fn = options.canUseTool as
    | ((
        tool: string,
        input: Record<string, unknown>,
        ctx: typeof toolCtx,
      ) => Promise<PermissionResult>)
    | undefined;
  if (!fn) throw new Error('canUseTool missing');
  return fn;
};

describe('claude-code approvals', () => {
  it('blocks canUseTool until the handler answers, then allows the push', async () => {
    let resolve!: (a: unknown) => void;
    const h = handler(() => new Promise((r) => (resolve = r)));
    let decision: PermissionResult | undefined;
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init({ session_id: 'sess-1' });
      const p = canUse(options)('Bash', { command: 'git push origin main' }, toolCtx);
      await new Promise((r) => setTimeout(r, 10));
      expect(decision).toBeUndefined();
      resolve({ approved: true, note: 'go' });
      decision = await p;
      yield msg.success('pushed');
    });
    const events = await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }));
    expect(decision).toMatchObject({ behavior: 'allow' });
    expect(h.requests[0]).toMatchObject({
      runId: 'r',
      nodeId: 'implement',
      role: 'backend',
      program: 'git',
      category: 'push',
      command: 'git push origin main',
      argv: ['git', 'push', 'origin', 'main'],
    });
    expect(events.find((e) => e.type === 'session')).toEqual({
      type: 'session',
      runtime: 'claude-code',
      sessionId: 'sess-1',
    });
    expect(events.at(-1)).toMatchObject({ type: 'result' });
  });

  it('uses approvedCommands without asking again, and denies an already denied command', async () => {
    const h = handler(async () => {
      throw new Error('must not be asked');
    });
    const decisions: PermissionResult[] = [];
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init();
      decisions.push(await canUse(options)('Bash', { command: 'git push origin main' }, toolCtx));
      decisions.push(await canUse(options)('Bash', { command: 'git push origin dev' }, toolCtx));
      yield msg.success('ok');
    });
    await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }), {
      approvedCommands: {
        [argvHash(['git', 'push', 'origin', 'main'])]: true,
        [argvHash(['git', 'push', 'origin', 'dev'])]: false,
      },
    });
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    expect(decisions[1]).toMatchObject({ behavior: 'deny' });
    expect(h.requests).toHaveLength(0);
  });

  it('a deferred answer interrupts and ends the task with approval_pending and the approval id', async () => {
    const h = handler(async () => ({ deferred: true, approvalId: 'a-42' }));
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init({ session_id: 's' });
      const d = await canUse(options)('Bash', { command: 'git push' }, toolCtx);
      expect(d).toMatchObject({ behavior: 'deny', interrupt: true });
      yield msg.error('error_during_execution', 0.2);
    });
    const events = await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      reason: 'approval_pending',
      approvalId: 'a-42',
      cost: { usd: 0.2 },
    });
  });

  it('a human denial denies the tool with the note', async () => {
    const h = handler(async () => ({ approved: false, note: 'not today' }));
    let decision: PermissionResult | undefined;
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init();
      decision = await canUse(options)('Bash', { command: 'git push' }, toolCtx);
      yield msg.success('ok');
    });
    await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }));
    expect(decision).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('not today'),
    });
  });

  it('resumes a session with the note as the prompt', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('continued')]);
    await run(
      new ClaudeCodeAdapter({ approvals: handler(async () => ({ approved: true })), queryFn: q }),
      {
        resumeSessionId: 'sess-1',
        resumeNote: 'The approval for `git push` was granted. Continue the task.',
      },
    );
    expect(q.calls[0]?.options.resume).toBe('sess-1');
    expect(q.calls[0]?.prompt).toBe('The approval for `git push` was granted. Continue the task.');
  });

  it('without a session, a resume note is appended to the normal prompt', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    await run(
      new ClaudeCodeAdapter({ approvals: handler(async () => ({ approved: true })), queryFn: q }),
      { resumeNote: 'The approval for `git push` was denied. Continue the task.' },
    );
    expect(q.calls[0]?.options.resume).toBeUndefined();
    expect(q.calls[0]?.prompt).toContain('Task: push it');
    expect(q.calls[0]?.prompt).toContain(
      'The approval for `git push` was denied. Continue the task.',
    );
  });

  it('maps tool ids, durations and parent tool use ids', async () => {
    const q = fakeQuery(() => [
      msg.init(),
      msg.toolUse('t1', 'Read', { file_path: 'a' }, { parent_tool_use_id: 'agent-1' }),
      msg.toolResult('t1', 'content', { parent_tool_use_id: 'agent-1' }),
      msg.success('ok'),
    ]);
    const events = await run(
      new ClaudeCodeAdapter({ approvals: handler(async () => ({ approved: true })), queryFn: q }),
      { role: role({ tools: ['read'] }) },
    );
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({
      id: 't1',
      parentToolUseId: 'agent-1',
    });
    const r = events.find((e) => e.type === 'tool_result') as {
      id?: string;
      durationMs?: number;
      parentToolUseId?: string;
    };
    expect(r.id).toBe('t1');
    expect(r.parentToolUseId).toBe('agent-1');
    expect(typeof r.durationMs).toBe('number');
  });
});
