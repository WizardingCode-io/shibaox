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
