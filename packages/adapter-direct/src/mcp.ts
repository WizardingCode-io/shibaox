import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerSpec } from '@wizardingcode/shibaox-core';

export interface McpToolInfo {
  /** The server's own tool name. */
  name: string;
  description: string;
  /** JSON Schema of the arguments, as the server declares it. */
  inputSchema: Record<string, unknown>;
}

/** A live MCP server: its (allowlisted) tools, a way to call them, and a way to stop it. */
export interface McpConnection {
  id: string;
  tools: McpToolInfo[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** `mcp__<server>__<tool>`: the name the model sees, the same in every runtime. */
export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/**
 * Starts (stdio) or reaches (http) an MCP server and lists its tools. A server that does not
 * answer within the spec's timeout, or exits, is an error naming the server; nothing hangs.
 */
export async function connectMcp(
  spec: McpServerSpec,
  o: { log?: (line: string) => void } = {},
): Promise<McpConnection> {
  const client = new Client({ name: 'shibaox', version: '0' });
  const transport =
    spec.transport === 'stdio'
      ? new StdioClientTransport({
          command: spec.command ?? '',
          args: spec.args ?? [],
          // the SDK's safe subset of the environment (PATH, HOME…) plus the spec's own
          env: { ...getDefaultEnvironment(), ...spec.env },
          stderr: 'pipe',
        })
      : new StreamableHTTPClientTransport(new URL(spec.url ?? ''), {
          requestInit: { headers: spec.headers ?? {} },
        });
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n'))
        if (line.trim()) o.log?.(`[mcp ${spec.id}] ${line}`);
    });
  const fail = (e: unknown) =>
    new Error(
      `mcp server "${spec.id}" failed to start: ${e instanceof Error ? e.message : String(e)}`,
    );
  try {
    await withTimeout(client.connect(transport), spec.timeoutMs, 'did not answer in time');
    const listed = await withTimeout(
      client.listTools(),
      spec.timeoutMs,
      'did not list its tools in time',
    );
    const allow = spec.tools ? new Set(spec.tools) : undefined;
    const tools: McpToolInfo[] = listed.tools
      .filter((t) => !allow || allow.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      }));
    return {
      id: spec.id,
      tools,
      async call(name, args) {
        const r = await client.callTool({ name, arguments: args }, undefined, {
          timeout: spec.timeoutMs,
        });
        const content = Array.isArray(r.content)
          ? (r.content as { type: string; text?: string }[])
          : [];
        const text = content
          .map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`))
          .join('\n');
        if (r.isError) throw new Error(text || 'the tool failed');
        return r.structuredContent ?? text;
      },
      async close() {
        await client.close().catch(() => undefined);
      },
    };
  } catch (e) {
    await client.close().catch(() => undefined);
    throw fail(e);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
