import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from '@wizardingcode/shibaox-schemas';

/** A resolved MCP server: what an adapter needs to start or reach it (secrets already inside). */
export interface McpServerSpec {
  id: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  /** stdio: the process environment on top of the daemon's (fixed env + the vault keys). */
  env: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
  const expand = (s: string) => s.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k: string) => keys[k] ?? m);
  const spec: McpServerSpec = {
    id: entry.id,
    transport: server.transport,
    env: { ...server.env, ...keys },
    timeoutMs: server.timeout_ms,
  };
  if (server.transport === 'stdio') {
    spec.command = server.command;
    spec.args = server.args;
  } else {
    spec.url = server.url;
    spec.headers = Object.fromEntries(
      Object.entries(server.headers).map(([k, v]) => [k, expand(v)]),
    );
  }
  if (server.tools) spec.tools = server.tools;
  return spec;
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
