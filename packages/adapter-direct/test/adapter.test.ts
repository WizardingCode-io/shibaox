import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterError,
  AutoApproveApprovals,
  collectRun,
  type RuntimeEvent,
  type TaskJob,
} from '@shibaox/core';
import { ProviderRegistry } from '@shibaox/providers';
import { startFakeOpenAI } from '@shibaox/providers/testing';
import { RoleSchema } from '@shibaox/schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DirectAdapter } from '../src/index.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
afterEach(async () => {
  await fake?.close();
});
const registry = (baseURL: string) =>
  new ProviderRegistry(
    [
      {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible',
        base_url: baseURL,
        auth: { type: 'none' },
        models: [],
        pricing: {},
        verify: false,
        capabilities: { tools: true },
      },
    ],
    {},
  );
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });
const jobFor = (workspace: string, tools: string[] = ['write', 'echo']): TaskJob => ({
  runId: 'r',
  nodeId: 'implement',
  role: RoleSchema.parse({
    role: 'backend',
    tools,
    system_prompt: undefined,
    description: 'Implements changes',
  }),
  instruction: 'create hello.txt with hi',
  input: { spec: 'x' },
  workspace,
  context: { previousOutputs: {} },
  approvedCommands: {},
});

describe('DirectAdapter', () => {
  it('writes a file through the tool, then finishes with a typed output', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi' } }] }
        : {
            toolCalls: [
              {
                name: 'finish',
                args: { output: { files: ['hello.txt'] }, summary: 'wrote hello.txt' },
              },
            ],
          },
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(jobFor(ws), ctx())) events.push(e);
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi');
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'usage', // the model ref, before the first call
      'tool_use',
      'file_changed',
      'tool_result',
      'tool_use',
      'tool_result',
      'usage', // tokens at the end
      'result',
    ]);
    const result = events.at(-1);
    expect(result?.type === 'result' && result.output).toEqual({ files: ['hello.txt'] });
  });
  it('finishes with the text when the model never calls finish', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'Nothing to do here.' }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    expect(r.output).toEqual({ text: 'Nothing to do here.' });
    expect(r.summary).toContain('Nothing to do');
  });
  it('refuses paths outside the workspace and reports it back to the model', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: [{ name: 'write_file', args: { path: '../evil.txt', content: 'x' } }] };
      const last = JSON.stringify(req.messages.at(-1));
      return { content: last.includes('escapes workspace') ? 'blocked' : 'not blocked' };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    expect(existsSync(join(ws, '../evil.txt'))).toBe(false);
    expect(r.output).toEqual({ text: 'blocked' });
  });
  it('only runs commands allowed by role.tools', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return {
          toolCalls: [
            { name: 'run_command', args: { command: 'rm -rf /' } },
            { name: 'run_command', args: { command: 'echo ok' } },
          ],
        };
      // tool message content is already a JSON string: echo it raw (no double encoding)
      return {
        content: (req.messages.slice(-2) as { content: string }[]).map((m) => m.content).join('\n'),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['echo']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text).toContain('not allowed');
    expect(text).toContain('"exitCode":0');
  });
  it('does not treat the read/write capability tools as runnable programs', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'run_command', args: { command: 'write root' } }] }
        : { content: (req.messages.at(-1) as { content: string }).content },
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['read', 'write', 'echo']), ctx());
    expect(String((r.output as { text: string }).text)).toContain(
      'command \\"write\\" is not allowed',
    );
  });
  it('refuses shell chaining, substitution and redirection even after an allowed program', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const cmds = [
      'echo ok; touch pwned',
      'echo ok && touch pwned',
      'echo ok | tee pwned',
      'echo $(touch pwned)',
      'echo `touch pwned`',
      'echo x > pwned',
    ];
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: cmds.map((command) => ({ name: 'run_command', args: { command } })) };
      return {
        content: (req.messages.slice(-cmds.length) as { content: string }[])
          .map((m) => m.content)
          .join('\n'),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['echo', 'touch', 'tee']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text.match(/not allowed/g)).toHaveLength(cmds.length);
    expect(existsSync(join(ws, 'pwned'))).toBe(false);
  });
  it('list_files does not follow symlinked directories (no loops, no escapes)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src/a.ts'), 'x');
    symlinkSync(ws, join(ws, 'loop'));
    symlinkSync(tmpdir(), join(ws, 'out'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0) return { toolCalls: [{ name: 'list_files', args: { subdir: '.' } }] };
      return { content: (req.messages.at(-1) as { content: string }).content };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    const listed = JSON.parse(String((r.output as { text: string }).text)) as { files: string[] };
    expect(listed.files.sort()).toEqual(['loop', 'out', join('src', 'a.ts')].sort());
  });

  it('does not leak host env: refuses $ expansion and scrubs the child env', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    process.env.FAKE_SECRET = 'top-secret-value';
    try {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell ${VAR} expansion under test
      const cmds = ['echo $FAKE_SECRET', 'echo ${FAKE_SECRET}', 'env'];
      fake = await startFakeOpenAI((req, turn) => {
        if (turn === 0)
          return { toolCalls: cmds.map((command) => ({ name: 'run_command', args: { command } })) };
        return {
          content: (req.messages.slice(-cmds.length) as { content: string }[])
            .map((m) => m.content)
            .join('\n'),
        };
      });
      const adapter = new DirectAdapter({
        registry: registry(fake.baseURL),
        resolveRef: () => 'fake/m',
      });
      const r = await collectRun(adapter, jobFor(ws, ['echo', 'env']), ctx());
      const text = String((r.output as { text: string }).text);
      expect(text.match(/not allowed/g)).toHaveLength(2);
      expect(text).toContain('"exitCode":0');
      expect(text).toContain('PATH=');
      expect(text).not.toContain('FAKE_SECRET');
      expect(text).not.toContain('top-secret-value');
    } finally {
      delete process.env.FAKE_SECRET;
    }
  });
  it('refuses command arguments that leave the workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const escapee = `shibaox-escape-${process.pid}-${Date.now()}`;
    const cmds = [
      `touch ../${escapee}`,
      `touch ~/${escapee}`,
      'cat /etc/passwd',
      `touch a/../../${escapee}`,
      'touch a.txt',
    ];
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: cmds.map((command) => ({ name: 'run_command', args: { command } })) };
      return {
        content: (req.messages.slice(-cmds.length) as { content: string }[])
          .map((m) => m.content)
          .join('\n'),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['touch', 'cat']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text.match(/leaves the workspace/g)).toHaveLength(4);
    expect(text).toContain(`argument \\"../${escapee}\\" leaves the workspace`);
    expect(existsSync(join(ws, 'a.txt'))).toBe(true);
    expect(existsSync(join(ws, '..', escapee))).toBe(false);
    expect(existsSync(join(homedir(), escapee))).toBe(false);
  });
  it('quoting, escaping and braces cannot smuggle a path out of the workspace', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'outer-'));
    writeFileSync(join(parent, 'secret.txt'), 'SECRET-OUTSIDE-CONTENT');
    const ws = join(parent, 'ws');
    mkdirSync(ws);
    const cmds = [
      "cat '..'/secret.txt",
      'cat ".."/secret.txt',
      'cat .\\./secret.txt',
      'cat {..,.}/secret.txt',
      'cat \\/etc/hosts',
      'cat --file=../secret.txt',
      'cat -o/etc/hosts',
    ];
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: cmds.map((command) => ({ name: 'run_command', args: { command } })) };
      return {
        content: (req.messages.slice(-cmds.length) as { content: string }[])
          .map((m) => m.content)
          .join('\n'),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['cat']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text).not.toContain('SECRET-OUTSIDE-CONTENT');
    expect(text).not.toContain('localhost'); // /etc/hosts was not read
    expect(text.match(/leaves the workspace/g)).toHaveLength(4);
    expect(text.match(/backslashes are not allowed/g)).toHaveLength(2);
  });
  it('runs commands as argv: quotes group words, nothing is expanded', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const cmds = ['echo "hello world"', "echo 'a  b' c", 'echo *', 'echo {a,b}'];
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: cmds.map((command) => ({ name: 'run_command', args: { command } })) };
      return {
        content: JSON.stringify(
          (req.messages.slice(-cmds.length) as { content: string }[]).map((m) => m.content),
        ),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['echo']), ctx());
    const outs = (JSON.parse(String((r.output as { text: string }).text)) as string[]).map(
      (c) => (JSON.parse(c) as { stdout: string }).stdout,
    );
    expect(outs).toEqual(['hello world\n', 'a  b c\n', '*\n', '{a,b}\n']);
  });
  it('write_file refuses .git paths (git config/hooks would run code)', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(ws, '.git'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return {
          toolCalls: [
            {
              name: 'write_file',
              args: { path: '.git/config', content: '[core]\n\tfsmonitor = touch pwned\n' },
            },
            { name: 'write_file', args: { path: 'sub/.GIT/hooks/x', content: 'x' } },
            { name: 'write_file', args: { path: '.gitignore', content: 'dist\n' } },
          ],
        };
      return {
        content: (req.messages.slice(-3) as { content: string }[]).map((m) => m.content).join('\n'),
      };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text.match(/targets \.git/g)).toHaveLength(2);
    expect(existsSync(join(ws, '.git/config'))).toBe(false);
    expect(existsSync(join(ws, 'sub'))).toBe(false);
    expect(readFileSync(join(ws, '.gitignore'), 'utf8')).toBe('dist\n');
  });
  it('run_command refuses arguments naming .git', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(ws, '.git'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0)
        return { toolCalls: [{ name: 'run_command', args: { command: 'touch .git/hooks-x' } }] };
      return { content: (req.messages.at(-1) as { content: string }).content };
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['touch']), ctx());
    expect(String((r.output as { text: string }).text)).toContain('targets .git');
    expect(existsSync(join(ws, '.git/hooks-x'))).toBe(false);
  });
  it('errors when maxSteps runs out without finish', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'list_files', args: { subdir: '.' } }],
    }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      maxSteps: 2,
    });
    await expect(collectRun(adapter, jobFor(ws), ctx())).rejects.toThrow(
      'max steps (2) reached without finish',
    );
  });

  it('attaches the cost of the attempt to the max-steps error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'list_files', args: { subdir: '.' } }],
    }));
    const priced = new ProviderRegistry(
      [
        {
          id: 'fake',
          name: 'Fake',
          kind: 'openai-compatible',
          base_url: fake.baseURL,
          auth: { type: 'none' },
          models: [],
          pricing: { m: { input_per_m: 1_000_000, output_per_m: 1_000_000 } },
          verify: false,
          capabilities: { tools: true },
        },
      ],
      {},
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: priced,
      resolveRef: () => 'fake/m',
      maxSteps: 2,
    });
    const err = await collectRun(adapter, jobFor(ws), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).cost?.usd).toBeGreaterThan(0);
    expect((err as AdapterError).cost?.inputTokens).toBeGreaterThan(0);
  });
  it('fails a truncated answer (finish_reason length) instead of treating it as a result', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'half an ans', finishReason: 'length' }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    await expect(collectRun(adapter, jobFor(ws), ctx())).rejects.toThrow(
      'model stopped with reason "length" without finish',
    );
  });
  it('reports provider errors with their message and HTTP status', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => {
      throw new Error('boom');
    });
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      maxRetries: 0,
    });
    const err = await collectRun(adapter, jobFor(ws), ctx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as Error).message).toContain('boom');
    expect((err as Error).message).toContain('500');
    expect(fake.requests).toHaveLength(1); // maxRetries: 0
  });

  it('exposes graph_query when a query function is given and logs progress', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const logs: string[] = [];
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'graph_query', args: { question: 'who calls add?' } }] }
        : { toolCalls: [{ name: 'finish', args: { output: { ok: true }, summary: 'done' } }] },
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      graphQuery: async (q) => `answer to ${q}`,
    });
    const r = await collectRun(adapter, jobFor(ws), {
      signal: new AbortController().signal,
      log: (l) => logs.push(l),
    });
    expect(r.output).toEqual({ ok: true });
    expect(logs.some((l) => l.includes('[direct] graph_query'))).toBe(true);
    const sent = JSON.stringify(fake.requests[1]);
    expect(sent).toContain('answer to who calls add?');
  });
  it('runs text-only for models without tool support', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req) => ({
      content: (req.tools?.length ?? 0) > 0 ? 'TOOLS WERE SENT' : 'plain answer',
    }));
    const reg = new ProviderRegistry(
      [
        {
          id: 'fake',
          name: 'Fake',
          kind: 'openai-compatible',
          base_url: fake.baseURL,
          auth: { type: 'none' },
          models: [],
          pricing: {},
          verify: false,
          capabilities: { tools: false },
        },
      ],
      {},
    );
    const r = await collectRun(
      new DirectAdapter({ registry: reg, resolveRef: () => 'fake/m' }),
      jobFor(ws),
      ctx(),
    );
    expect(r.output).toEqual({ text: 'plain answer' });
  });
  it('read-only roles get no write_file or run_command', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req) => ({
      content: JSON.stringify(
        (req.tools as { function: { name: string } }[]).map((t) => t.function.name),
      ),
    }));
    const job = {
      ...jobFor(ws, ['echo']),
      role: RoleSchema.parse({ role: 'analyst', capabilities: ['read-only'], tools: ['echo'] }),
    };
    const r = await collectRun(
      new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' }),
      job,
      ctx(),
    );
    const names = JSON.parse((r.output as { text: string }).text) as string[];
    expect(names).toEqual(expect.arrayContaining(['list_files', 'read_file', 'finish']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('run_command');
  });

  it('sends the conversation as prior turns and the new request last', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'sure' }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      preamble: () => 'Project: Node · 3 files',
    });
    const job = {
      ...jobFor(ws),
      input: {
        spec: 'and now?',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      },
    };
    await collectRun(adapter, job, ctx());
    const msgs = (fake.requests[0] as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[0]?.content).toContain('Project: Node · 3 files');
    expect(msgs[1]?.content).toBe('hello');
    expect(msgs[2]?.content).toBe('hi');
    expect(msgs[3]?.content).toContain('and now?');
    expect(msgs[3]?.content).not.toContain('"messages"');
  });
  it('role.max_steps caps the tool loop', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ toolCalls: [{ name: 'list_files', args: {} }] }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const job = { ...jobFor(ws), role: RoleSchema.parse({ role: 'r', tools: [], max_steps: 2 }) };
    await expect(collectRun(adapter, job, ctx())).rejects.toThrow('max steps (2) reached');
    expect(fake.requests).toHaveLength(2);
  });
  it('extra tools from the daemon are callable', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'ping', args: { n: 1 } }] }
        : { toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }] },
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      extraTools: () => [
        {
          name: 'ping',
          description: 'pong',
          input: z.object({ n: z.number() }),
          execute: async (i) => ({ pong: i.n }),
        },
      ],
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(jobFor(ws), ctx())) events.push(e);
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'ping');
    expect(result?.type === 'tool_result' && result.output).toEqual({ pong: 1 });
  });

  it('reports the model ref when it starts and the tokens when it ends', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'hi' }));
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(jobFor(ws), ctx())) events.push(e);
    const usage = events.filter((e) => e.type === 'usage');
    expect(usage[0]).toEqual({ type: 'usage', model: 'fake/m' });
    expect(usage[1]).toMatchObject({
      type: 'usage',
      model: 'fake/m',
      contextTokens: expect.any(Number),
      outputTokens: expect.any(Number),
    });
    expect(usage[1]).not.toHaveProperty('contextWindow'); // the fake provider has no window
    expect(events.map((e) => e.type).slice(-2)).toEqual(['usage', 'result']);
  });

  it('aborts when the signal fires', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(
      () => new Promise((r) => setTimeout(() => r({ content: 'late' }), 2_000)) as never,
    );
    const adapter = new DirectAdapter({
      approvals: new AutoApproveApprovals(),
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(
      collectRun(adapter, jobFor(ws), { signal: ac.signal, log: () => {} }),
    ).rejects.toThrow();
  });
});
