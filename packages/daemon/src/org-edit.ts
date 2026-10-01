import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { isSeq, parse as parseYaml } from 'yaml';
import { readDoc, writeAtomic } from './org-config.js';

/** A refused org edit, with the HTTP status the API answers and any extra body fields. */
export class OrgEditError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrgEditError';
  }
}

/** `id → file` of the YAML files of an org directory (`roles`, `catalog`), keyed by `key`. */
export function filesById(root: string, sub: string, key: string): Map<string, string> {
  const dir = join(root, sub);
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    try {
      const raw = parseYaml(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      const id = raw?.[key];
      if (typeof id === 'string' && !out.has(id)) out.set(id, join(dir, name));
    } catch {
      // a file that does not parse is the org loader's to report
    }
  }
  return out;
}

/**
 * Replaces one list (`mcp` or `skills`) of a role file, keeping its comments and the flow style
 * the file used (`[a, b]`). The result is checked against the role schema before it is written.
 */
export function setRoleList(file: string, key: 'mcp' | 'skills', list: string[]): void {
  const doc = readDoc(file);
  const prev = doc.get(key, true);
  const node = doc.createNode(list);
  if (!prev || (isSeq(prev) && prev.flow) || list.length === 0) node.flow = true;
  doc.set(key, node);
  const parsed = RoleSchema.safeParse(doc.toJS() ?? {});
  if (!parsed.success)
    throw new OrgEditError(
      400,
      'bad_request',
      `${file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  writeAtomic(file, doc.toString());
}

/** Removes `id` from `key` of every role file that lists it; returns the roles changed. */
export function detachFromRoles(root: string, key: 'mcp' | 'skills', id: string): string[] {
  const changed: string[] = [];
  for (const [role, file] of filesById(root, 'roles', 'role')) {
    const raw = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const list = Array.isArray(raw?.[key]) ? (raw[key] as unknown[]).map(String) : [];
    if (!list.includes(id)) continue;
    setRoleList(
      file,
      key,
      list.filter((x) => x !== id),
    );
    changed.push(role);
  }
  return changed.sort();
}
