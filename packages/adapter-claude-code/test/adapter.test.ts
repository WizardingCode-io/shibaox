import {
  AutoApproveHuman,
  collectRun,
  DeferHuman,
  type RuntimeEvent,
  type TaskJob,
} from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';
import { fakeQuery, msg } from '../src/testing/fake-query.js';

const job = (extra: Partial<TaskJob> = {}): TaskJob => ({
  runId: 'r',
  nodeId: 'implement',
  role: RoleSchema.parse({
    role: 'backend',
    tools: ['read', 'write', 'git'],
    system_prompt: undefined,
    description: 'Backend dev',
  }),
  instruction: 'add /health',
  input: { spec: 'x' },
  workspace: '/tmp/ws',
  context: { previousOutputs: {} },
  budgetRemainingUsd: 2.5,
  ...extra,
});
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });

describe('ClaudeCodeAdapter', () => {
  it('passes role, workspace, budget and tool rules to query and maps messages to events', async () => {
    const q = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'graphify', status: 'connected' }] }),
      msg.text('working'),
      msg.toolUse('t1', 'Edit', { file_path: 'src/a.ts', old_string: '', new_string: 'x' }),
      msg.toolResult('t1', 'ok'),
      msg.success('done', { structured_output: { files: ['src/a.ts'] } }),
    ]);
    const adapter = new ClaudeCodeAdapter({
      human: new AutoApproveHuman(),
      queryFn: q,
      mcpServers: () => ({
        graphify: { type: 'stdio', command: 'python', args: ['-m', 'graphify.serve'] },
      }),
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(job(), ctx())) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'text',
      'text',
      'tool_use',
      'file_changed',
      'tool_result',
      'result',
    ]);
    const result = events.at(-1);
    expect(result?.type === 'result' && result.output).toEqual({ files: ['src/a.ts'] });
    expect(result?.type === 'result' && result.cost).toEqual({
      usd: 0.12,
      inputTokens: 100,
      outputTokens: 50,
    });
    const o = q.calls[0]?.options ?? {};
    expect(o.cwd).toBe('/tmp/ws');
    expect(o.maxBudgetUsd).toBe(2.5);
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.allowedTools).toEqual(
      expect.arrayContaining(['Read', 'Edit', 'Bash(git *)', 'mcp__graphify__*']),
    );
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash(git push *)']));
    expect(o.settings).toEqual({ permissions: { ask: [] } });
    expect(o.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('Backend dev'),
    });
    expect(q.calls[0]?.prompt).toContain('add /health');
  });
  it('turns an error result into an error event with cost', async () => {
    const q = fakeQuery(() => [msg.init(), msg.error('error_max_turns', 0.3)]);
    const adapter = new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q });
    await expect(collectRun(adapter, job(), ctx())).rejects.toMatchObject({
      message: expect.stringContaining('error_max_turns'),
      cost: { usd: 0.3 },
    });
  });
  it('uses the text result when there is no structured output', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('All good.')]);
    const r = await collectRun(
      new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }),
      job(),
      ctx(),
    );
    expect(r.output).toEqual({ text: 'All good.' });
  });
  it('aborts the query when the signal fires', async () => {
    const q = fakeQuery(({ options }) =>
      (async function* () {
        yield msg.init();
        await new Promise((r, rej) => {
          options.abortController?.signal.addEventListener('abort', () =>
            rej(new Error('aborted')),
          );
          setTimeout(r, 2000);
        });
        yield msg.success('late');
      })(),
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(
      collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }), job(), {
        signal: ac.signal,
        log: () => {},
      }),
    ).rejects.toThrow(/abort/);
  });
  it('warns when an MCP server failed to connect', async () => {
    const logs: string[] = [];
    const q = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'graphify', status: 'failed' }] }),
      msg.success('x'),
    ]);
    await collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }), job(), {
      signal: new AbortController().signal,
      log: (l) => logs.push(l),
    });
    expect(logs.join('\n')).toContain('graphify');
    expect(logs.join('\n')).toContain('failed');
  });
  it('ends the task with an approval-pending error when the human defers a push', async () => {
    const q = fakeQuery(({ options }) =>
      (async function* () {
        yield msg.init();
        const r = await options.canUseTool?.('Bash', { command: 'git push origin main' }, {
          signal: new AbortController().signal,
          toolUseID: 't1',
        } as never);
        expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
        expect(options.settings).toEqual({
          permissions: { ask: expect.arrayContaining(['Bash(git push *)']) },
        });
        expect(options.disallowedTools).not.toContain('Bash(git push *)');
        yield msg.error('error_during_execution', 0.2);
      })(),
    );
    const role = RoleSchema.parse({
      role: 'backend',
      tools: ['git'],
      permissions: { approval_required: ['push'] },
    });
    await expect(
      collectRun(
        new ClaudeCodeAdapter({ human: new DeferHuman(), queryFn: q }),
        job({ role }),
        ctx(),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('approval pending'),
      cost: { usd: 0.2 },
    });
  });
  it('merges the configured env over the inherited process env', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('x')]);
    await collectRun(
      new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q, env: { FOO: 'bar' } }),
      job(),
      ctx(),
    );
    expect(q.calls[0]?.options.env).toMatchObject({ FOO: 'bar', PATH: process.env.PATH });
  });
});
