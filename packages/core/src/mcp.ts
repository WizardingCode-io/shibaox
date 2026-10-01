import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from '@wizardingcode/shibaox-schemas';

/** A resolved MCP server: what an adapter needs to start or reach it (secrets already inside). */
export interface McpServerSpec {
  id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** stdio: fixed environment on top of the daemon's (never secrets). */
  env: Record<string, string>;
  /** The vault keys the server needs, with their values: passed to the process env, expanded in headers. */
  secrets: Record<string, string>;
  url?: string;
  /** http: headers as written, `${KEY}` left for the runtime to expand (see expandHeaders). */
  headers?: Record<string, string>;
  /** http: a command whose stdout is the bearer token; `withBearer` runs it and sets the header. */
  bearerCommand?: string[];
  /** When set, only these tools are offered. */
  tools?: string[];
  timeoutMs: number;
}

/**
 * The spec of a catalog `mcp` entry with its `env_keys` read from the environment (the vault
 * sits on top of it). A missing key is a clear error: the role asked for a server it cannot
 * start. `${KEY}` in header values is expanded from the same keys.
 */
export function mcpServerSpec(entry: CatalogEntry, env: NodeJS.ProcessEnv): McpServerSpec {
  const server = entry.server;
  if (entry.type !== 'mcp') throw new Error(`catalog entry "${entry.id}" is not an mcp entry`);
  if (!server) throw new Error(`catalog entry "${entry.id}" has no server: nothing to start`);
  const keys: Record<string, string> = {};
  for (const k of server.env_keys) {
    const v = env[k];
    if (typeof v !== 'string' || v === '')
      throw new Error(
        `catalog entry "${entry.id}" needs ${k} in the vault (shibaox keys set ${k})`,
      );
    keys[k] = v;
  }
  const spec: McpServerSpec = {
    id: entry.id,
    transport: server.transport,
    env: { ...server.env },
    secrets: keys,
    timeoutMs: server.timeout_ms,
  };
  if (server.transport === 'stdio') {
    spec.command = server.command;
    spec.args = server.args;
  } else {
    spec.url = server.url;
    spec.headers = { ...server.headers };
    if (server.bearer_command) spec.bearerCommand = [...server.bearer_command];
  }
  if (server.tools) spec.tools = server.tools;
  return spec;
}

/** The http headers with `${KEY}` expanded from the spec's secrets (what the direct adapter sends). */
export function expandHeaders(spec: McpServerSpec): Record<string, string> {
  return Object.fromEntries(
    Object.entries(spec.headers ?? {}).map(([k, v]) => [
      k,
      v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (m, key: string) => spec.secrets[key] ?? m),
    ]),
  );
}

/** Ids a role may not list under `mcp:`: in-process servers of the runtimes, or unusable as tool names. */
export function mcpIdProblem(id: string): string | undefined {
  if (id === 'shibaox' || id === 'graphify') return `"${id}" is reserved for a built-in server`;
  if (id.includes(':') || id.includes('__'))
    return `"${id}" cannot be a tool name (no ':' or '__' in an mcp id)`;
  return undefined;
}

/**
 * The name the model sees for a server's tool: `mcp__<server>__<tool>` with only
 * `[A-Za-z0-9_-]`, at most 64 characters (a short hash keeps long names distinct), the same in
 * every runtime.
 */
export function modelToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (raw.length <= 64) return raw;
  const hash = createHash('sha1').update(`${server}\u0000${tool}`).digest('hex').slice(0, 6);
  return `${raw.slice(0, 64 - 7)}_${hash}`;
}

/**
 * The skills of a role as prompt text: each `skills/<id>/SKILL.md` (frontmatter dropped)
 * under a heading with its id. Nothing when the role has no skills; a missing file throws.
 */
export function skillsPrompt(orgRoot: string, ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined;
  const parts = ids.map((id) => {
    const rel = join('skills', id, 'SKILL.md');
    const p = join(orgRoot, rel);
    if (!existsSync(p)) throw new Error(`skill "${id}" has no ${rel} in the org`);
    return `## Skill: ${id}\n${stripFrontmatter(readFileSync(p, 'utf8')).trim()}`;
  });
  return parts.join('\n\n');
}

function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** What a bearer command's run returns. */
export interface BearerRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * The spec with its bearer resolved: the command run once, its stdout (trimmed) in the
 * Authorization header, the command dropped so it is not run again. A failing command is an
 * error naming the server and what to run (the CLI login).
 */
export async function withBearer(
  spec: McpServerSpec,
  run: (argv: string[]) => Promise<BearerRun>,
): Promise<McpServerSpec> {
  const argv = spec.bearerCommand;
  if (!argv || argv.length === 0) return spec;
  const r = await run(argv);
  if (r.exitCode !== 0)
    throw new Error(
      `mcp server "${spec.id}": the bearer command (${argv.join(' ')}) failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`}`,
    );
  const token = r.stdout.trim().split('\n').pop()?.trim() ?? '';
  if (!token)
    throw new Error(
      `mcp server "${spec.id}": the bearer command (${argv.join(' ')}) printed no token`,
    );
  const { bearerCommand: _dropped, ...rest } = spec;
  return { ...rest, headers: { ...spec.headers, Authorization: `Bearer ${token}` } };
}

/** The user bins a service's PATH lacks, appended once: where a CLI installed by hand lives. */
export function augmentPath(path: string | undefined, home: string | undefined): string {
  const parts = (path ?? '').split(':').filter(Boolean);
  const extra = [...(home ? [`${home}/.local/bin`] : []), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  return parts.join(':');
}
