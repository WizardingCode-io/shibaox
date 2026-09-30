// A tiny stdio MCP server for tests: echo, shout, secret (reads ECHO_TOKEN), fail.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool(
  'echo',
  { description: 'Echoes the text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);
server.registerTool(
  'shout',
  { description: 'Upper-cases the text', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] }),
);
server.registerTool(
  'secret',
  { description: 'Tells the ECHO_TOKEN it was started with', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: process.env.ECHO_TOKEN ?? '(none)' }] }),
);
server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'boom' }],
  isError: true,
}));
server.registerTool('cwd', { description: 'Where the server runs', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: process.cwd() }],
}));
server.registerTool('big', { description: 'A very long result', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'x'.repeat(300_000) }],
}));
server.registerTool(
  'weird.name',
  { description: 'A dotted tool name', inputSchema: {} },
  async () => ({
    content: [{ type: 'text', text: 'weird ok' }],
  }),
);
await server.connect(new StdioServerTransport());
