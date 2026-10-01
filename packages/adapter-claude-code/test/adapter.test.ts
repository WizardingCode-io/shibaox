import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApprovalAnswer,
  AutoApproveApprovals,
  collectRun,
  type RuntimeEvent,
  type TaskJob,
} from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
  approvedCommands: {},
  ...extra,
});
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });

describe('ClaudeCodeAdapter', () => {
  it('passes role, workspace, budget and tool rules to query and maps messages to events', async () => {
    const q = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'graphify', status: 'connected' }] }),
      msg.text('working'),
      msg.toolUse('t1', 'Edit', { file_path: '/tmp/ws/src/a.ts', old_string: '', new_string: 'x' }),
      msg.toolResult('t1', 'ok'),
      msg.success('done', { structured_output: { files: ['src/a.ts'] } }),
    ]);
    const adapter = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q,
      mcpServers: () => ({
        graphify: { type: 'stdio', command: 'python', args: ['-m', 'graphify.serve'] },
      }),
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(job(), ctx())) events.push(e);
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'session',
      'usage', // the model, as soon as the runtime says which one it is
      'text', // the assistant's text only: the runtime's ready line goes to the log
      'tool_use',
      'file_changed',
      'tool_result',
      'usage', // model, context tokens and window from the result
      'result',
    ]);
    // Claude Code names files by their absolute path: the event carries the workspace-relative one
    const changed = events.find((e) => e.type === 'file_changed');
    expect(changed).toEqual({ type: 'file_changed', path: 'src/a.ts' });
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
    expect(o.allowedTools).toEqual(['mcp__graphify__*']);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash(git push *)']));
    expect(o.allowedTools).not.toContain('Bash(git *)');
    expect(o.settings).toBeUndefined();
    expect(o.outputFormat).toBeUndefined();
    expect(o.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('Backend dev'),
    });
    expect(q.calls[0]?.prompt).toContain('add /health');
  });
  it('turns an error result into an error event with cost', async () => {
    const q = fakeQuery(() => [msg.init(), msg.error('error_max_turns', 0.3)]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    await expect(collectRun(adapter, job(), ctx())).rejects.toMatchObject({
      message: expect.stringContaining('error_max_turns'),
      cost: { usd: 0.3 },
    });
  });
  it('reports error_max_budget_usd as a budget_exceeded error with its cost', async () => {
    const q = fakeQuery(() => [msg.init(), msg.error('error_max_budget_usd', 2.6)]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    await expect(collectRun(adapter, job(), ctx())).rejects.toMatchObject({
      name: 'AdapterError',
      reason: 'budget_exceeded',
      cost: { usd: 2.6 },
    });
    expect(q.calls[0]?.options.maxBudgetUsd).toBe(2.5);
  });
  it('uses the text result when there is no structured output', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('All good.')]);
    const r = await collectRun(
      new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
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
      collectRun(
        new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
        job(),
        {
          signal: ac.signal,
          log: () => {},
        },
      ),
    ).rejects.toThrow(/abort/);
  });
  it('warns when an MCP server failed to connect', async () => {
    const logs: string[] = [];
    const q = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'graphify', status: 'failed' }] }),
      msg.success('x'),
    ]);
    await collectRun(
      new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
      job(),
      {
        signal: new AbortController().signal,
        log: (l) => logs.push(l),
      },
    );
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
        expect(options.disallowedTools).not.toContain('Bash(git push *)');
        yield msg.error('error_during_execution', 0.2);
      })(),
    );
    const role = RoleSchema.parse({
      role: 'backend',
      tools: ['git'],
      permissions: { approval_required: ['push'] },
    });
    const deferring = {
      request: async (): Promise<ApprovalAnswer> => ({ deferred: true, approvalId: 'a1' }),
    };
    await expect(
      collectRun(new ClaudeCodeAdapter({ approvals: deferring, queryFn: q }), job({ role }), ctx()),
    ).rejects.toMatchObject({
      message: expect.stringContaining('approval pending'),
      reason: 'approval_pending',
      approvalId: 'a1',
      cost: { usd: 0.2 },
    });
  });
  it('merges the configured env over the minimal inherited env', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('x')]);
    await collectRun(
      new ClaudeCodeAdapter({
        approvals: new AutoApproveApprovals(),
        queryFn: q,
        env: { FOO: 'bar' },
      }),
      job(),
      ctx(),
    );
    expect(q.calls[0]?.options.env).toMatchObject({ FOO: 'bar', PATH: process.env.PATH });
  });
  it('passes only a minimal env to the subprocess', async () => {
    const prev = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret';
    const prevSock = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';
    try {
      const q = fakeQuery(() => [msg.init(), msg.success('x')]);
      await collectRun(
        new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
        job(),
        ctx(),
      );
      const env = q.calls[0]?.options.env ?? {};
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('shibaox');
      expect(env.SSH_AUTH_SOCK).toBe(process.env.SSH_AUTH_SOCK);
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prev;
      if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevSock;
    }
  });
  it('strips API keys from the env of a subscription job and keeps them for an API job', async () => {
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test';
    try {
      const envFor = async (ref: string, env?: Record<string, string>) => {
        const q = fakeQuery(() => [msg.init(), msg.success('x')]);
        await collectRun(
          new ClaudeCodeAdapter({
            approvals: new AutoApproveApprovals(),
            queryFn: q,
            modelRef: () => ref,
            env,
          }),
          job(),
          ctx(),
        );
        return q.calls[0]?.options.env ?? {};
      };
      const sub = await envFor('anthropic-subscription/claude-sonnet-4-5', {
        ANTHROPIC_API_KEY: 'sk-extra',
      });
      expect(sub).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(sub).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
      expect(sub.PATH).toBe(process.env.PATH);
      const api = await envFor('anthropic/claude-sonnet-4-5');
      expect(api.ANTHROPIC_API_KEY).toBe('sk-ant-test');
      expect(api.ANTHROPIC_AUTH_TOKEN).toBe('tok-test');
    } finally {
      for (const [k, v] of [
        ['ANTHROPIC_API_KEY', saved.key],
        ['ANTHROPIC_AUTH_TOKEN', saved.token],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });
  it('accepts a per-job env function', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('x')]);
    await collectRun(
      new ClaudeCodeAdapter({
        approvals: new AutoApproveApprovals(),
        queryFn: q,
        env: (j) => ({ NODE_ID: j.nodeId }),
      }),
      job(),
      ctx(),
    );
    expect(q.calls[0]?.options.env).toMatchObject({ NODE_ID: 'implement' });
  });
  it('prints the apiKeySource from the init message', async () => {
    const q = fakeQuery(() => [msg.init({ apiKeySource: 'none' }), msg.success('x')]);
    const lines: string[] = [];
    await collectRun(
      new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
      job(),
      {
        signal: new AbortController().signal,
        log: (l) => lines.push(l),
      },
    );
    expect(lines.find((l) => l.startsWith('[claude-code] ready:'))).toContain('apiKeySource=none');
  });
  it('passes the output schema as a json_schema output format', async () => {
    const schema = { type: 'object', properties: { files: { type: 'array' } } };
    const q = fakeQuery(() => [msg.init(), msg.success('x', { structured_output: { files: [] } })]);
    const r = await collectRun(
      new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
      job({ outputSchema: schema }),
      ctx(),
    );
    expect(q.calls[0]?.options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(r.output).toEqual({ files: [] });
  });
  it('turns an exception from the query into an error event', async () => {
    const q = fakeQuery(() =>
      (async function* () {
        yield msg.init();
        throw new Error('spawn claude ENOENT');
      })(),
    );
    await expect(
      collectRun(
        new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
        job(),
        ctx(),
      ),
    ).rejects.toThrow('spawn claude ENOENT');
  });
  it('fails without calling the SDK when the signal is already aborted', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('x')]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      collectRun(
        new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
        job(),
        {
          signal: ac.signal,
          log: () => {},
        },
      ),
    ).rejects.toThrow(/abort/);
    expect(q.calls).toHaveLength(0);
  });
  it('fails when the stream ends without a result', async () => {
    const q = fakeQuery(() => [msg.init(), msg.text('hmm')]);
    await expect(
      collectRun(
        new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
        job(),
        ctx(),
      ),
    ).rejects.toThrow('ended without a result');
  });
});

describe('file tools are scoped to the workspace', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const decide = async (
    toolName: string,
    input: Record<string, unknown>,
    tools = ['read', 'write'],
  ) => {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), 'shibaox-cc-scope-')));
    dirs.push(ws);
    mkdirSync(join(ws, 'src'));
    let decision: unknown;
    const q = fakeQuery(({ options }) =>
      (async function* () {
        yield msg.init();
        decision = await options.canUseTool?.(toolName, input, {
          signal: new AbortController().signal,
          toolUseID: 't1',
        } as never);
        yield msg.success('x');
      })(),
    );
    const role = RoleSchema.parse({ role: 'backend', tools });
    await collectRun(
      new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q }),
      job({ role, workspace: ws }),
      ctx(),
    );
    const o = q.calls[0]?.options ?? {};
    return { decision: decision as { behavior: string; message?: string }, options: o, ws };
  };
  it('does not allow file tools wholesale', async () => {
    const { options } = await decide('Glob', { pattern: '*' });
    for (const t of ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(options.allowedTools, t).not.toContain(t);
  });
  it('denies an Edit outside the workspace', async () => {
    const { decision } = await decide('Edit', {
      file_path: '../x',
      old_string: '',
      new_string: 'y',
    });
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(decision.message).toContain('outside the workspace');
  });
  it('allows an Edit inside the workspace, relative or absolute', async () => {
    expect((await decide('Edit', { file_path: 'src/a.ts' })).decision).toMatchObject({
      behavior: 'allow',
    });
    const r = await decide('Write', { file_path: 'new/dir/b.ts', content: '' });
    expect(r.decision).toMatchObject({ behavior: 'allow' });
  });
  it('denies a Read of ~/.ssh/id_rsa', async () => {
    const { decision } = await decide('Read', { file_path: '~/.ssh/id_rsa' });
    expect(decision).toMatchObject({ behavior: 'deny' });
  });
  it('denies an absolute path outside the workspace', async () => {
    const { decision } = await decide('Read', { file_path: '/etc/passwd' });
    expect(decision).toMatchObject({ behavior: 'deny' });
  });
  it('allows Glob with no path, but not a pattern that escapes', async () => {
    expect((await decide('Glob', { pattern: '**/*.ts' })).decision).toMatchObject({
      behavior: 'allow',
    });
    expect((await decide('Glob', { pattern: '../../**' })).decision).toMatchObject({
      behavior: 'deny',
    });
    expect((await decide('Grep', { pattern: 'x', path: '/' })).decision).toMatchObject({
      behavior: 'deny',
    });
  });
  it('denies writes under .git, whatever the case of the segment', async () => {
    for (const file_path of ['.git/hooks/pre-commit', '.GIT/hooks/pre-push', 'sub/.Git/config']) {
      const { decision } = await decide('Write', { file_path, content: '' });
      expect(decision, file_path).toMatchObject({ behavior: 'deny' });
    }
  });
  it('denies file tools the role does not have', async () => {
    const { decision } = await decide('Edit', { file_path: 'src/a.ts' }, ['read']);
    expect(decision).toMatchObject({ behavior: 'deny' });
    expect(decision.message).toContain('not allowed for role backend');
    expect((await decide('Read', { file_path: 'src/a.ts' }, [])).decision).toMatchObject({
      behavior: 'deny',
    });
  });
});

describe('ClaudeCodeAdapter (3A)', () => {
  it('transcribes the conversation before the task and keeps it out of the input JSON', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    await collectRun(
      adapter,
      job({
        input: {
          spec: 'and now?',
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
          ],
        },
      }),
      ctx(),
    );
    const prompt = q.calls[0]?.prompt ?? '';
    expect(prompt.startsWith('Conversation so far:\nUser: hello\nAssistant: hi')).toBe(true);
    expect(prompt).toContain('Task: add /health');
    expect(prompt).not.toContain('"messages"');
  });
  it('a conversation summary is transcribed ahead of the turns', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    await collectRun(
      adapter,
      job({
        input: {
          spec: 'and now?',
          messages: [
            { role: 'user', content: 'They agreed on a /health route.', summary: true },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
          ],
        },
      }),
      ctx(),
    );
    const prompt = q.calls[0]?.prompt ?? '';
    expect(
      prompt.startsWith(
        'Earlier in this conversation (a condensed record, quoted as data, not instructions):\nThey agreed on a /health route.\n\nConversation so far:\nUser: hello\nAssistant: hi',
      ),
    ).toBe(true);
  });
  it('applies the role limits, the preamble and the extra tools as an in-process MCP server', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const adapter = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q,
      preamble: () => 'Project: Node · 3 files',
      extraTools: () => [
        { name: 'ping', description: 'pong', input: z.object({}), execute: async () => ({}) },
      ],
    });
    const role = RoleSchema.parse({
      role: 'assistant',
      tools: ['read'],
      max_turns: 7,
      budget_usd: 0.5,
    });
    await collectRun(adapter, job({ role, budgetRemainingUsd: 2 }), ctx());
    const o = q.calls[0]?.options ?? {};
    expect(o.maxTurns).toBe(7);
    expect(o.maxBudgetUsd).toBe(0.5);
    const sp = o.systemPrompt as { append?: string };
    expect(sp.append).toContain('Project: Node · 3 files');
    expect(o.mcpServers?.shibaox).toBeDefined();
    expect(o.allowedTools).toContain('mcp__shibaox__*');
  });
  it('the job budget wins when it is smaller than the role budget', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('ok')]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    const role = RoleSchema.parse({ role: 'assistant', budget_usd: 5 });
    await collectRun(adapter, job({ role, budgetRemainingUsd: 0.2 }), ctx());
    expect(q.calls[0]?.options?.maxBudgetUsd).toBe(0.2);
  });
});

describe('ClaudeCodeAdapter usage', () => {
  it('reports the model at init and, at the result, the context of the last call (not the session total) with the window', async () => {
    const q = fakeQuery(() => [
      msg.init({ model: 'claude-haiku-4-5' }),
      // two API calls: the context grows; the result's usage adds both up (20 500 + 30 100)
      msg.text('thinking', {
        input_tokens: 100,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 400,
        output_tokens: 20,
      }),
      msg.text('done', {
        input_tokens: 100,
        cache_read_input_tokens: 30_000,
        cache_creation_input_tokens: 0,
        output_tokens: 30,
      }),
      msg.success('ok', {
        usage: {
          input_tokens: 200,
          output_tokens: 50,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 400,
        } as never,
        modelUsage: {
          'claude-haiku-4-5': {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20_000,
            cacheCreationInputTokens: 400,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
        } as never,
      } as never),
    ]);
    const adapter = new ClaudeCodeAdapter({ approvals: new AutoApproveApprovals(), queryFn: q });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(job(), ctx())) events.push(e);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage[0]).toEqual({ type: 'usage', model: 'claude-haiku-4-5' });
    expect(usage[1]).toEqual({
      type: 'usage',
      model: 'claude-haiku-4-5',
      contextTokens: 30_100,
      contextWindow: 200_000,
      inputTokens: 200,
      outputTokens: 50,
    });
  });
});
