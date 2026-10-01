import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema } from '../src/index.js';

describe('an http mcp server with a bearer command', () => {
  it('keeps the command that prints the token (the CLI login stands in for a key)', () => {
    const e = CatalogEntrySchema.parse({
      id: 'higgsfield',
      type: 'mcp',
      description: 'x',
      server: {
        transport: 'http',
        url: 'https://mcp.higgsfield.ai/mcp',
        bearer_command: ['higgsfield', 'auth', 'token'],
        tools: ['generate_image_batch'],
      },
    });
    expect(e.server?.bearer_command).toEqual(['higgsfield', 'auth', 'token']);
  });
  it('a stdio server has no bearer command', () => {
    expect(() =>
      CatalogEntrySchema.parse({
        id: 'x',
        type: 'mcp',
        description: 'x',
        server: { transport: 'stdio', command: 'npx', bearer_command: ['a'] },
      }),
    ).toThrow(/bearer_command/);
  });
});

describe('key names in a server block', () => {
  const base = {
    id: 'x',
    type: 'mcp',
    description: 'x',
    server: { transport: 'http', url: 'https://e.com/mcp' },
  };
  it('env_keys are UPPER_CASE names of vault entries, never values', () => {
    const r = CatalogEntrySchema.safeParse({
      ...base,
      server: { ...base.server, env_keys: ['f676-0db0:4cca224bee'] },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/name of a vault entry/);
    expect(
      CatalogEntrySchema.safeParse({ ...base, server: { ...base.server, env_keys: ['ACME_KEY'] } })
        .success,
    ).toBe(true);
  });
  it('a placeholder in a header must be a key name too', () => {
    const r = CatalogEntrySchema.safeParse({
      ...base,
      server: { ...base.server, headers: { Authorization: ['Key $', '{abc:def}'].join('') } },
    });
    expect(r.success).toBe(false);
    expect(
      CatalogEntrySchema.safeParse({
        ...base,
        server: { ...base.server, headers: { Authorization: ['Bearer $', '{ACME_KEY}'].join('') } },
      }).success,
    ).toBe(true);
  });
});
