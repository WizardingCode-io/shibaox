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
import { collectRun, type RuntimeEvent, type TaskJob } from '@shibaox/core';
import { ProviderRegistry } from '@shibaox/providers';
import { startFakeOpenAI } from '@shibaox/providers/testing';
import { RoleSchema } from '@shibaox/schemas';
import { afterEach, describe, expect, it } from 'vitest';
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
      },
    ],
    {},
  );
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });
const jobFor = (workspace: string, tools: string[] = ['echo']): TaskJob => ({
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
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(jobFor(ws), ctx())) events.push(e);
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi');
    expect(events.map((e) => e.type)).toEqual([
      'started',
      'tool_use',
      'file_changed',
      'tool_result',
      'tool_use',
      'tool_result',
      'result',
    ]);
    const result = events.at(-1);
    expect(result?.type === 'result' && result.output).toEqual({ files: ['hello.txt'] });
  });
  it('finishes with the text when the model never calls finish', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'Nothing to do here.' }));
    const adapter = new DirectAdapter({
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
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
    });
    const r = await collectRun(adapter, jobFor(ws, ['echo']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text).toContain('not allowed');
    expect(text).toContain('"exitCode":0');
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
  it('errors when maxSteps runs out without finish', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'list_files', args: { subdir: '.' } }],
    }));
    const adapter = new DirectAdapter({
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      maxSteps: 2,
    });
    await expect(collectRun(adapter, jobFor(ws), ctx())).rejects.toThrow(
      'max steps (2) reached without finish',
    );
  });

  it('aborts when the signal fires', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(
      () => new Promise((r) => setTimeout(() => r({ content: 'late' }), 2_000)) as never,
    );
    const adapter = new DirectAdapter({
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
