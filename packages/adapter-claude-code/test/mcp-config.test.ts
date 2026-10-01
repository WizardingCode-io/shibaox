import {
  AutoApproveApprovals,
  type McpServerSpec,
  type TaskJob,
  withBearer,
} from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, mcpAllowRules, mcpSecrets, mcpServerConfigs } from '../src/index.js';
import { fakeQuery, msg } from '../src/testing/fake-query.js';

const specs = [
  {
    id: 'echo',
    transport: 'stdio' as const,
    command: 'node',
    args: ['echo.mjs'],
    env: { T: '1' },
    secrets: { ECHO_TOKEN: 's3cret' },
    tools: ['echo'],
    timeoutMs: 30_000,
  },
  {
    id: 'web',
    transport: 'http' as const,
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: `Bearer $${'{WEB_TOKEN}'}` },
    env: {},
    secrets: { WEB_TOKEN: 'w3b' },
    timeoutMs: 30_000,
  },
];

describe('MCP servers for Claude Code', () => {
  it('turns the specs into the SDK server configs, secrets replaced by placeholders', () => {
    // the config travels on the CLI argv: never a secret in it; Claude Code expands `${KEY}`
    // from the subprocess environment, which carries the real values (mcpSecrets)
    expect(mcpServerConfigs(specs)).toEqual({
      echo: {
        type: 'stdio',
        command: 'node',
        args: ['echo.mjs'],
        env: { T: '1', ECHO_TOKEN: `$${'{ECHO_TOKEN}'}` },
      },
      web: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: `Bearer $${'{WEB_TOKEN}'}` },
      },
    });
    expect(JSON.stringify(mcpServerConfigs(specs))).not.toMatch(/s3cret|w3b/);
    expect(mcpSecrets(specs)).toEqual({ ECHO_TOKEN: 's3cret', WEB_TOKEN: 'w3b' });
  });
  it('allows every tool of a server, or only the allowlisted ones', () => {
    expect(mcpAllowRules(specs)).toEqual(['mcp__echo__echo', 'mcp__web__*']);
  });
});

describe('the adapter with catalog servers', () => {
  const job = (): TaskJob => ({
    runId: 'r',
    nodeId: 'n',
    role: RoleSchema.parse({ role: 'qa', tools: ['read'], mcp: ['echo'] }),
    instruction: 'x',
    input: {},
    workspace: process.cwd(),
    context: { previousOutputs: {} },
    approvedCommands: {},
  });
  it('passes the servers with placeholders and the secrets through the subprocess env', async () => {
    const q = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'echo', status: 'connected' }] }),
      msg.success('ok'),
    ]);
    const a = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q,
      mcpSpecs: () => [specs[0]],
    });
    for await (const _ of a.run(job(), { signal: new AbortController().signal, log: () => {} })) {
      // drain
    }
    const o = q.calls[0]?.options ?? {};
    expect(JSON.stringify(o.mcpServers)).not.toContain('s3cret');
    expect(
      (o.mcpServers as Record<string, { env?: Record<string, string> }>).echo?.env?.ECHO_TOKEN,
    ).toBe(`$${'{ECHO_TOKEN}'}`);
    expect((o.env as Record<string, string>).ECHO_TOKEN).toBe('s3cret');
    expect(o.allowedTools).toContain('mcp__echo__echo');
  });
  it('a catalog server that failed to start fails the task; other servers only log', async () => {
    const q = fakeQuery(() => [
      msg.init({
        mcp_servers: [
          { name: 'echo', status: 'failed' },
          { name: 'graphify', status: 'failed' },
        ],
      }),
      msg.success('ok'),
    ]);
    const a = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q,
      mcpSpecs: () => [specs[0]],
    });
    const events = [];
    for await (const e of a.run(job(), { signal: new AbortController().signal, log: () => {} }))
      events.push(e);
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect((events.at(-1) as { message: string }).message).toMatch(
      /mcp server "echo" failed to start/,
    );
    const q2 = fakeQuery(() => [
      msg.init({ mcp_servers: [{ name: 'graphify', status: 'failed' }] }),
      msg.success('ok'),
    ]);
    const b = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q2,
      mcpSpecs: () => [specs[0]],
    });
    const ok = [];
    for await (const e of b.run(job(), { signal: new AbortController().signal, log: () => {} }))
      ok.push(e);
    expect(ok.at(-1)).toMatchObject({ type: 'result' });
  });

  it('a bearer resolved from a command reaches the subprocess env, never the mcp config', async () => {
    const spec: McpServerSpec = {
      id: 'hf',
      transport: 'http',
      url: 'https://mcp.example/mcp',
      env: {},
      secrets: {},
      headers: {},
      bearerCommand: ['fake-token-cmd'],
      timeoutMs: 1000,
    };
    const resolved = await withBearer(spec, async () => ({
      exitCode: 0,
      stdout: 'oat_zz\n',
      stderr: '',
    }));
    expect(JSON.stringify(mcpServerConfigs([resolved]))).not.toContain('oat_zz');
    expect(mcpSecrets([resolved])).toEqual({ SHIBAOX_BEARER_HF: 'oat_zz' });
  });
  it('a server whose bearer command fails is left out with a warning; the turn still runs', async () => {
    const q = fakeQuery(() => [msg.init({ mcp_servers: [] }), msg.success('ok')]);
    const a = new ClaudeCodeAdapter({
      approvals: new AutoApproveApprovals(),
      queryFn: q,
      mcpSpecs: () => [
        {
          id: 'hf',
          transport: 'http',
          url: 'https://mcp.example/mcp',
          env: {},
          secrets: {},
          headers: {},
          bearerCommand: ['definitely-missing-cmd-xyz'],
          timeoutMs: 1000,
        },
      ],
    });
    const events: { type: string; message?: string }[] = [];
    for await (const e of a.run(job(), { signal: new AbortController().signal, log: () => {} }))
      events.push(e as { type: string; message?: string });
    expect(q.calls).toHaveLength(1);
    expect(Object.keys(q.calls[0]?.options?.mcpServers ?? {})).not.toContain('hf');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(
      events.some(
        (e) => e.type === 'text' && /hf.*off this turn/i.test((e as { text?: string }).text ?? ''),
      ),
    ).toBe(true);
  });
});
