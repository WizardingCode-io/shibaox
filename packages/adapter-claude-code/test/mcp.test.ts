import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mcpToolDefinitions, sdkMcpServer } from '../src/index.js';

const tools = [
  {
    name: 'ping',
    description: 'pong',
    input: z.object({ n: z.number() }),
    execute: async (i: Record<string, unknown>) => ({ pong: i.n }),
  },
  {
    name: 'boom',
    description: 'fails',
    input: z.object({}),
    execute: async () => {
      throw new Error('nope');
    },
  },
];

describe('sdkMcpServer', () => {
  it('turns AgentTools into MCP tool definitions that answer with JSON text', async () => {
    const defs = mcpToolDefinitions(tools);
    expect(defs.map((d) => d.name)).toEqual(['ping', 'boom']);
    expect(defs[0]?.description).toBe('pong');
    const ok = await defs[0]?.handler({ n: 2 } as never, {});
    expect(ok).toEqual({ content: [{ type: 'text', text: JSON.stringify({ pong: 2 }) }] });
    const err = await defs[1]?.handler({} as never, {});
    expect(err).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ error: 'nope' }) }],
      isError: true,
    });
  });
  it('builds an in-process server config', () => {
    const server = sdkMcpServer('shibaox', tools);
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('shibaox');
    expect(server.instance).toBeDefined();
  });
});
