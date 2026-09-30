import { describe, expect, it } from 'vitest';
import { mcpAllowRules, mcpServerConfigs } from '../src/index.js';

const specs = [
  {
    id: 'echo',
    transport: 'stdio' as const,
    command: 'node',
    args: ['echo.mjs'],
    env: { T: '1' },
    tools: ['echo'],
    timeoutMs: 30_000,
  },
  {
    id: 'web',
    transport: 'http' as const,
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer x' },
    env: {},
    timeoutMs: 30_000,
  },
];

describe('MCP servers for Claude Code', () => {
  it('turns the specs into the SDK server configs', () => {
    expect(mcpServerConfigs(specs)).toEqual({
      echo: { type: 'stdio', command: 'node', args: ['echo.mjs'], env: { T: '1' } },
      web: {
        type: 'http',
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    });
  });
  it('allows every tool of a server, or only the allowlisted ones', () => {
    expect(mcpAllowRules(specs)).toEqual(['mcp__echo__echo', 'mcp__web__*']);
  });
});
