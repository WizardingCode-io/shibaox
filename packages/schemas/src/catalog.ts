import { z } from 'zod';
import { Id } from './common.js';

/** How to reach an MCP server: a process on stdio, or a Streamable HTTP endpoint. */
export const McpServerSchema = z
  .object({
    transport: z.enum(['stdio', 'http']),
    /** stdio: the executable to start (resolved on PATH). */
    command: z.string().min(1).optional(),
    args: z.array(z.string()).default([]),
    /** http: the endpoint URL. */
    url: z.string().url().optional(),
    /** Fixed environment for a stdio server (never secrets: use `env_keys`). */
    env: z.record(z.string(), z.string()).default({}),
    /** Vault keys the server needs: passed to a stdio process, or expanded as `${KEY}` in headers. */
    env_keys: z.array(z.string().min(1)).default([]),
    headers: z.record(z.string(), z.string()).default({}),
    /** Only these tools are offered when set (the server's names, without the mcp__ prefix). */
    tools: z.array(z.string().min(1)).optional(),
    /** Start/connect and per-call timeout. */
    timeout_ms: z.number().int().positive().default(30_000),
  })
  .superRefine((s, ctx) => {
    if (s.transport === 'stdio' && !s.command)
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'a stdio server needs a command',
      });
    if (s.transport === 'http' && !/^https?:\/\//.test(s.url ?? ''))
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'an http server needs an http(s) url',
      });
  });
export type McpServer = z.infer<typeof McpServerSchema>;

export const CatalogEntrySchema = z.object({
  id: Id,
  type: z.enum(['team', 'workflow', 'skill', 'plugin', 'mcp', 'tool']),
  description: z.string().min(1).max(200),
  tags: z.array(z.string()).default([]),
  /**
   * For `type: mcp`: how to start or reach the server, so a role may list it under `mcp:`.
   * Without it the entry is a built-in capability marker (e.g. `graphify-mcp`) that
   * autorouting may attach; it cannot be started.
   */
  server: McpServerSchema.optional(),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
