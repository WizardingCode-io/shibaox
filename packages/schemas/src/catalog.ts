import { z } from 'zod';
import { Id } from './common.js';

/** How to reach an MCP server: a process on stdio, or a Streamable HTTP endpoint. */
/** The name of a vault entry: UPPER_CASE, never the value itself (a value belongs in the vault). */
export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const KeyNameSchema = z
  .string()
  .regex(
    KEY_NAME_RE,
    'is not the name of a vault entry (UPPER_CASE such as ACME_KEY): a key name goes here, never its value',
  );
/** `${NAME}` placeholders of header values must be key names too. */
export const PLACEHOLDER_RE = /\$\{([^}]*)\}/g;
export function badPlaceholder(headers: Record<string, string>): string | undefined {
  for (const v of Object.values(headers))
    for (const m of v.matchAll(PLACEHOLDER_RE))
      if (!KEY_NAME_RE.test(m[1] ?? '')) return m[1] ?? '';
  return undefined;
}

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
    env_keys: z.array(KeyNameSchema).default([]),
    headers: z.record(z.string(), z.string()).default({}),
    /** http: a command whose stdout is the bearer token, run before each connection (a CLI's login stands in for a key). */
    bearer_command: z.array(z.string().min(1)).min(1).optional(),
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
    if (s.transport === 'stdio' && s.bearer_command)
      ctx.addIssue({
        code: 'custom',
        path: ['bearer_command'],
        message:
          'bearer_command is for http servers (a stdio server gets its keys through env_keys)',
      });
    if (badPlaceholder(s.headers) !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the catalog's placeholder syntax
          'a ${…} placeholder in a header is not the name of a vault entry (UPPER_CASE such as ACME_KEY): a key name goes there, never its value',
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
/** A server as written (defaults not applied yet): what the app and the CLI send. */
export type McpServerInput = z.input<typeof McpServerSchema>;
