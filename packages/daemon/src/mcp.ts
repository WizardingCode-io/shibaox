import { connectMcp } from '@wizardingcode/shibaox-adapter-direct';
import { mcpServerSpec } from '@wizardingcode/shibaox-core';
import { loadOrg } from '@wizardingcode/shibaox-schemas';

/** One MCP server of an org's catalog, as `shibaox mcp list` shows it. */
export interface McpServerRow {
  id: string;
  description: string;
  transport: 'stdio' | 'http';
  /** The command line (stdio) or the URL (http). */
  target: string;
  /** The allowlist, when the entry has one. */
  tools?: string[];
  /** Roles that list this server. */
  roles: string[];
  /** The vault keys it needs, and whether each is set. */
  keys: { name: string; present: boolean }[];
}

export interface McpTestResult {
  ok: boolean;
  tools?: { name: string; description: string }[];
  error?: string;
}

/** The catalog's MCP servers of the org at `root`, with who uses them and what keys they miss. */
export function mcpList(root: string, env: NodeJS.ProcessEnv): McpServerRow[] {
  const org = loadOrg(root);
  const rows: McpServerRow[] = [];
  for (const e of Object.values(org.catalog)) {
    if (e.type !== 'mcp' || !e.server) continue;
    const s = e.server;
    rows.push({
      id: e.id,
      description: e.description,
      transport: s.transport,
      target: s.transport === 'stdio' ? [s.command, ...s.args].join(' ') : (s.url ?? ''),
      ...(s.tools ? { tools: s.tools } : {}),
      roles: Object.values(org.roles)
        .filter((r) => r.mcp.includes(e.id))
        .map((r) => r.role)
        .sort(),
      keys: s.env_keys.map((name) => ({
        name,
        present: typeof env[name] === 'string' && env[name] !== '',
      })),
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

/** Starts (or reaches) one catalog server, lists its tools and stops it: the health check. */
export async function mcpTest(
  id: string,
  root: string,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<McpTestResult> {
  const org = loadOrg(root);
  const entry = org.catalog[id];
  if (entry?.type !== 'mcp' || !entry.server) throw new Error(`mcp server "${id}" not found`);
  try {
    const conn = await connectMcp(mcpServerSpec(entry, env), { log });
    try {
      return {
        ok: true,
        tools: conn.tools.map((t) => ({ name: t.name, description: t.description })),
      };
    } finally {
      await conn.close();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
