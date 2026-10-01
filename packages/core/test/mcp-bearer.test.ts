import { describe, expect, it } from 'vitest';
import { expandHeaders, MissingKeyError, mcpServerSpec, withBearer } from '../src/index.js';

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
    // the token travels as a secret (an env var for Claude Code), never written into the header text
    expect(resolved.headers).toEqual({ Authorization: 'Bearer ${SHIBAOX_BEARER_HIGGSFIELD}' });
    expect(resolved.secrets).toEqual({ SHIBAOX_BEARER_HIGGSFIELD: 'oat_abc' });
    expect(expandHeaders(resolved)).toEqual({ Authorization: 'Bearer oat_abc' });
    expect(resolved.bearerCommand).toBeUndefined(); // resolved: not run again
  });
  it('a failing or empty command is a clear error naming the server, never carrying stdout', async () => {
    const spec = mcpServerSpec(entry, {});
    await expect(
      withBearer(spec, async () => ({ exitCode: 1, stdout: '', stderr: 'Not authenticated' })),
    ).rejects.toThrow(/higgsfield.*higgsfield auth token.*Not authenticated/);
    await expect(
      withBearer(spec, async () => ({ exitCode: 1, stdout: 'oat_leaked', stderr: '' })),
    ).rejects.not.toThrow(/oat_leaked/);
    // a notice around the token: the token is the last line that is one word
    const r = await withBearer(spec, async () => ({
      exitCode: 0,
      stdout: 'warning: a new version is available\noat_real\nRun higgsfield upgrade to update\n',
      stderr: '',
    }));
    expect(r.secrets.SHIBAOX_BEARER_HIGGSFIELD).toBe('oat_real');
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

describe('a server whose vault key is missing', () => {
  it('throws a MissingKeyError naming the server and the key', () => {
    const entry = {
      id: 'acme',
      type: 'mcp' as const,
      description: 'x',
      tags: [],
      server: {
        transport: 'http' as const,
        url: 'https://e.com/mcp',
        args: [],
        env: {},
        env_keys: ['ACME_KEY'],
        headers: {},
        timeout_ms: 1000,
      },
    };
    let err: unknown;
    try {
      mcpServerSpec(entry, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingKeyError);
    expect((err as MissingKeyError).serverId).toBe('acme');
    expect((err as MissingKeyError).key).toBe('ACME_KEY');
  });
});
