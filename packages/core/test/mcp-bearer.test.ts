import { describe, expect, it } from 'vitest';
import { expandHeaders, mcpServerSpec, withBearer } from '../src/index.js';

const entry = {
  id: 'higgsfield',
  type: 'mcp' as const,
  description: 'x',
  tags: [],
  server: {
    transport: 'http' as const,
    url: 'https://mcp.higgsfield.ai/mcp',
    args: [],
    env: {},
    env_keys: [],
    headers: {},
    bearer_command: ['higgsfield', 'auth', 'token'],
    timeout_ms: 1000,
  },
};

describe('bearer from a command', () => {
  it('the spec carries the command; withBearer runs it and sets the Authorization header', async () => {
    const spec = mcpServerSpec(entry, {});
    expect(spec.bearerCommand).toEqual(['higgsfield', 'auth', 'token']);
    const ran: string[][] = [];
    const resolved = await withBearer(spec, async (argv) => {
      ran.push(argv);
      return { exitCode: 0, stdout: 'oat_abc\n', stderr: '' };
    });
    expect(ran).toEqual([['higgsfield', 'auth', 'token']]);
    expect(expandHeaders(resolved)).toEqual({ Authorization: 'Bearer oat_abc' });
    expect(resolved.bearerCommand).toBeUndefined(); // resolved: not run again
  });
  it('a failing or empty command is a clear error naming the server', async () => {
    const spec = mcpServerSpec(entry, {});
    await expect(
      withBearer(spec, async () => ({ exitCode: 1, stdout: '', stderr: 'Not authenticated' })),
    ).rejects.toThrow(/higgsfield.*higgsfield auth token.*Not authenticated/);
    await expect(
      withBearer(spec, async () => ({ exitCode: 0, stdout: '  ', stderr: '' })),
    ).rejects.toThrow(/printed no token/);
  });
  it('a spec without a command is returned as is', async () => {
    const plain = mcpServerSpec(
      { ...entry, server: { ...entry.server, bearer_command: undefined } },
      {},
    );
    expect(await withBearer(plain, async () => ({ exitCode: 0, stdout: 'x', stderr: '' }))).toBe(
      plain,
    );
  });
});
