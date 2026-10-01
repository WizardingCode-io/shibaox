import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoApproveApprovals, type RuntimeEvent, type TaskJob } from '@wizardingcode/shibaox-core';
import { ProviderRegistry } from '@wizardingcode/shibaox-providers';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectAdapter, type McpServerSpec } from '../src/index.js';

const fixture = fileURLToPath(new URL('./fixtures/mcp-echo.mjs', import.meta.url));
let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
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
const echoSpec = (extra: Partial<McpServerSpec> = {}): McpServerSpec => ({
  id: 'echo',
  transport: 'stdio',
  command: process.execPath,
  args: [fixture],
  env: {},
  timeoutMs: 20_000,
  ...extra,
});
const job = (ws: string, role: Record<string, unknown> = {}): TaskJob => ({
  runId: 'r',
  nodeId: 'implement',
  role: RoleSchema.parse({ role: 'qa', tools: ['read'], mcp: ['echo'], ...role }),
  instruction: 'use the echo server',
  input: { spec: 'x' },
  workspace: ws,
  context: { previousOutputs: {} },
  approvedCommands: {},
});
const adapterWith = (
  baseURL: string,
  o: Partial<ConstructorParameters<typeof DirectAdapter>[0]> = {},
) =>
  new DirectAdapter({
    approvals: new AutoApproveApprovals(),
    registry: registry(baseURL),
    resolveRef: () => 'fake/m',
    ...o,
  });
async function collect(a: DirectAdapter, j: TaskJob): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of a.run(j, ctx())) out.push(e);
  return out;
}
const toolNames = (r: unknown) =>
  ((r as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);

describe('MCP servers on a role (direct adapter)', () => {
  it('offers the server tools as mcp__<id>__<tool>, calls one, and closes the server', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'mcp__echo__echo', args: { text: 'hi' } }] }
        : { toolCalls: [{ name: 'finish', args: { output: { done: true }, summary: 'echoed' } }] },
    );
    const events = await collect(
      adapterWith(fake.baseURL, { mcpServers: () => [echoSpec()] }),
      job(ws),
    );
    expect(toolNames(fake.requests[0])).toEqual(
      expect.arrayContaining(['mcp__echo__echo', 'mcp__echo__shout', 'finish']),
    );
    const use = events.find((e) => e.type === 'tool_use' && e.name === 'mcp__echo__echo');
    expect(use).toBeDefined();
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'mcp__echo__echo');
    expect(JSON.stringify(result)).toContain('echo: hi');
    expect(events.at(-1)).toMatchObject({ type: 'result', output: { done: true } });
  });
  it('the tools allowlist hides the other tools; env reaches the server; an error result is an error', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? {
            toolCalls: [
              { name: 'mcp__echo__secret', args: {} },
              { name: 'mcp__echo__fail', args: {} },
            ],
          }
        : { toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }] },
    );
    const spec = echoSpec({ env: { ECHO_TOKEN: 's3cret' }, tools: ['secret', 'fail'] });
    const events = await collect(adapterWith(fake.baseURL, { mcpServers: () => [spec] }), job(ws));
    const names = toolNames(fake.requests[0]);
    expect(names).toContain('mcp__echo__secret');
    expect(names).not.toContain('mcp__echo__echo');
    expect(
      JSON.stringify(
        events.find((e) => e.type === 'tool_result' && e.name === 'mcp__echo__secret'),
      ),
    ).toContain('s3cret');
    expect(
      JSON.stringify(events.find((e) => e.type === 'tool_result' && e.name === 'mcp__echo__fail')),
    ).toMatch(/error.*boom/);
  });
  it('a server that cannot start fails the task naming the server', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }],
    }));
    const bad = echoSpec({ args: [join(ws, 'missing.mjs')], timeoutMs: 5_000 });
    const events = await collect(adapterWith(fake.baseURL, { mcpServers: () => [bad] }), job(ws));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((events.at(-1) as { message?: string }).message).toMatch(
      /mcp server "echo" failed to start/,
    );
    expect(fake.requests).toHaveLength(0);
  });
  it('a stdio server runs in the task workspace, huge results are cut, odd tool names are made safe', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) =>
      turn === 0
        ? {
            toolCalls: [
              { name: 'mcp__echo__cwd', args: {} },
              { name: 'mcp__echo__big', args: {} },
              { name: 'mcp__echo__weird_name', args: {} },
            ],
          }
        : { toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }] },
    );
    const events = await collect(
      adapterWith(fake.baseURL, { mcpServers: () => [echoSpec()] }),
      job(ws),
    );
    const result = (name: string) =>
      events.find((e) => e.type === 'tool_result' && e.name === name) as
        | { output?: unknown }
        | undefined;
    expect(String(result('mcp__echo__cwd')?.output)).toBe(realpathSync(ws));
    const big = String(result('mcp__echo__big')?.output);
    expect(big.length).toBeLessThan(120_000);
    expect(big).toMatch(/truncated/);
    expect(String(result('mcp__echo__weird_name')?.output)).toBe('weird ok');
    expect(toolNames(fake.requests[0])).toContain('mcp__echo__weird_name');
    expect(toolNames(fake.requests[0])).not.toContain('mcp__echo__weird.name');
  });
  it('the skills of the role reach the system prompt', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    const orgRoot = mkdtempSync(join(tmpdir(), 'org-'));
    mkdirSync(join(orgRoot, 'skills', 'greet'), { recursive: true });
    writeFileSync(
      join(orgRoot, 'skills', 'greet', 'SKILL.md'),
      '---\nname: greet\n---\nAlways greet in Portuguese.\n',
    );
    fake = await startFakeOpenAI(() => ({
      toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }],
    }));
    await collect(adapterWith(fake.baseURL, { orgRoot }), job(ws, { mcp: [], skills: ['greet'] }));
    const req = fake.requests[0] as { messages: { role: string; content: string }[] };
    const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('## Skill: greet\nAlways greet in Portuguese.');
    expect(system).not.toContain('name: greet');
  });

  it('a server whose bearer command fails is left out with a note; the task still runs', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'Fine without it.' }));
    const spec: McpServerSpec = {
      id: 'hf',
      transport: 'http',
      url: 'https://mcp.example/mcp',
      env: {},
      secrets: {},
      headers: {},
      bearerCommand: ['definitely-missing-cmd-xyz'],
      timeoutMs: 1000,
    };
    const events = await collect(adapterWith(fake.baseURL, { mcpServers: () => [spec] }), job(ws));
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'result')).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'text' && /hf.*off this turn/i.test((e as { text: string }).text),
      ),
    ).toBe(true);
  });
});
