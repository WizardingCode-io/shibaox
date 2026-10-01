import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { connectMcp } from '@wizardingcode/shibaox-adapter-direct';
import { mcpIdProblem, mcpServerSpec } from '@wizardingcode/shibaox-core';
import { CatalogEntrySchema, loadOrg, type McpServerInput } from '@wizardingcode/shibaox-schemas';
import { Document } from 'yaml';
import { readDoc, writeAtomic } from './org-config.js';
import { detachFromRoles, filesById, OrgEditError } from './org-edit.js';
import { attachToRoles } from './roles.js';

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

/** What `POST /mcp` takes: a catalog entry of type mcp, and the roles to give it to. */
export interface McpAddRequest {
  id: string;
  description: string;
  tags?: string[];
  server: McpServerInput;
  roles?: string[];
  /** Overwrite an existing entry with this id (else 409). */
  replace?: boolean;
}

/** The server as it goes in the file: empty defaults left out, `${KEY}` header keys listed. */
function serverForFile(s: McpServerInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fromHeaders = Object.values(s.headers ?? {}).flatMap((v) =>
    [...String(v).matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1] as string),
  );
  const envKeys = [...new Set([...(s.env_keys ?? []), ...fromHeaders])];
  const withKeys: Record<string, unknown> = { ...s, env_keys: envKeys };
  for (const k of [
    'transport',
    'command',
    'args',
    'url',
    'env',
    'env_keys',
    'headers',
    'bearer_command',
    'tools',
    'timeout_ms',
  ]) {
    const v = withKeys[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0 && k !== 'tools') continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (k === 'timeout_ms' && v === 30_000) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Writes `catalog/<id>.yaml` (the file that already holds the id when replacing, comments
 * kept) and adds the id to `roles`. Everything is validated before the disk is touched.
 */
export function mcpAdd(root: string, req: McpAddRequest, env: NodeJS.ProcessEnv): McpServerRow {
  const org = loadOrg(root);
  if (!req || typeof req !== 'object')
    throw new OrgEditError(400, 'bad_request', 'a body {id, description, server} is required');
  const problem = typeof req.id === 'string' ? mcpIdProblem(req.id) : undefined;
  if (problem) throw new OrgEditError(400, 'bad_request', `mcp ${problem}`);
  if (!req.server || typeof req.server !== 'object')
    throw new OrgEditError(400, 'bad_request', '"server" is required');
  const server = serverForFile(req.server);
  const entry = {
    id: req.id,
    type: 'mcp' as const,
    description: req.description,
    ...(req.tags?.length ? { tags: req.tags } : {}),
    server,
  };
  const parsed = CatalogEntrySchema.safeParse(entry);
  if (!parsed.success)
    throw new OrgEditError(
      400,
      'bad_request',
      parsed.error.issues.map((i) => `${i.path.join('.') || 'entry'}: ${i.message}`).join('; '),
    );
  const roles = req.roles ?? [];
  if (!Array.isArray(roles) || !roles.every((r) => typeof r === 'string'))
    throw new OrgEditError(400, 'bad_request', '"roles" must be a list of role ids');
  for (const r of roles)
    if (!org.roles[r]) throw new OrgEditError(400, 'bad_request', `role ${r} not found`);
  const existing = filesById(root, 'catalog', 'id').get(req.id);
  if (existing && !req.replace)
    throw new OrgEditError(409, 'exists', `catalog entry ${req.id} already exists (replace it?)`);
  if (existing && org.catalog[req.id]?.type !== 'mcp')
    throw new OrgEditError(409, 'exists', `catalog entry ${req.id} is not an mcp entry`);
  let text: string;
  if (existing) {
    const doc = readDoc(existing);
    doc.set('description', req.description);
    if (req.tags !== undefined) doc.set('tags', req.tags);
    doc.set('server', doc.createNode(server));
    text = doc.toString();
  } else {
    const doc = new Document(entry);
    doc.commentBefore =
      ' Added from the app or `shibaox mcp add`; give it to a role with mcp: [id].';
    text = doc.toString();
  }
  writeAtomic(existing ?? join(root, 'catalog', `${req.id}.yaml`), text);
  attachToRoles(root, 'mcp', req.id, roles);
  const row = mcpList(root, env).find((r) => r.id === req.id);
  if (!row) throw new OrgEditError(500, 'internal', `catalog entry ${req.id} did not load`);
  return row;
}

/** Detaches the server from every role, then deletes its catalog file. */
export function mcpRemove(root: string, id: string): { removed: true } {
  const org = loadOrg(root);
  const file = filesById(root, 'catalog', 'id').get(id);
  if (!file || org.catalog[id]?.type !== 'mcp')
    throw new OrgEditError(404, 'not_found', `mcp server ${id} not found`);
  detachFromRoles(root, 'mcp', id);
  if (existsSync(file)) unlinkSync(file);
  return { removed: true };
}
