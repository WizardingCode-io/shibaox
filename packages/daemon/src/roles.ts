import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mcpIdProblem } from '@wizardingcode/shibaox-core';
import { Id, loadOrg, type Org } from '@wizardingcode/shibaox-schemas';
import { filesById, OrgEditError, setRoleList } from './org-edit.js';

/** A role as the Customize screen shows it: what it may use. */
export interface RoleRow {
  id: string;
  name: string;
  description?: string;
  /** `models.yaml roles.<id>.model`, when the org pins one. */
  model?: string;
  tools: string[];
  mcp: string[];
  skills: string[];
}

/** The lists `PUT /roles/:id` replaces (a missing one stays as it is). */
export interface RolePatch {
  mcp?: string[];
  skills?: string[];
}

/** `obj[id]` only when `id` is the object's own key (never `toString`, `constructor`…). */
export const own = <T>(obj: Record<string, T>, id: string): T | undefined =>
  Object.hasOwn(obj, id) ? obj[id] : undefined;

const rowOf = (org: Org, id: string): RoleRow => {
  const r = own(org.roles, id);
  if (!r) throw new OrgEditError(404, 'not_found', `role ${id} not found`);
  const model = own(org.models.roles, id)?.model;
  return {
    id,
    name: r.role,
    ...(r.description ? { description: r.description } : {}),
    ...(model ? { model } : {}),
    tools: r.tools,
    mcp: r.mcp,
    skills: r.skills,
  };
};

export function listRoles(root: string): RoleRow[] {
  const org = loadOrg(root);
  return Object.keys(org.roles)
    .sort()
    .map((id) => rowOf(org, id));
}

function idList(v: unknown, key: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
    throw new OrgEditError(400, 'bad_request', `"${key}" must be a list of ids`);
  for (const id of v)
    if (!Id.safeParse(id).success)
      throw new OrgEditError(400, 'bad_request', `"${key}": "${id}" is not an id`);
  return [...new Set(v as string[])];
}

/** Replaces a role's `mcp` / `skills` lists after checking every id against the catalog and the skills. */
export function putRole(root: string, id: string, patch: RolePatch): RoleRow {
  const org = loadOrg(root);
  if (!own(org.roles, id)) throw new OrgEditError(404, 'not_found', `role ${id} not found`);
  const body = (patch ?? {}) as Record<string, unknown>;
  const mcp = idList(body.mcp, 'mcp');
  const skills = idList(body.skills, 'skills');
  for (const m of mcp ?? []) {
    const problem = mcpIdProblem(m);
    if (problem) throw new OrgEditError(400, 'bad_request', `mcp ${problem}`);
    const e = own(org.catalog, m);
    if (!e) throw new OrgEditError(400, 'bad_request', `mcp server "${m}" is not in the catalog`);
    if (e.type !== 'mcp' || !e.server)
      throw new OrgEditError(
        400,
        'bad_request',
        `catalog entry "${m}" is not an mcp server with a server: to start`,
      );
  }
  for (const s of skills ?? [])
    if (!existsSync(join(root, 'skills', s, 'SKILL.md')))
      throw new OrgEditError(400, 'bad_request', `skill "${s}" has no skills/${s}/SKILL.md`);
  const file = filesById(root, 'roles', 'role').get(id);
  if (!file) throw new OrgEditError(404, 'not_found', `role ${id} not found`);
  if (mcp) setRoleList(file, 'mcp', mcp);
  if (skills) setRoleList(file, 'skills', skills);
  return rowOf(loadOrg(root), id);
}

/** Adds `id` to `key` of each role (roles must exist; checked before anything is written). */
export function attachToRoles(root: string, key: 'mcp' | 'skills', id: string, roles: string[]) {
  const org = loadOrg(root);
  const files = filesById(root, 'roles', 'role');
  for (const r of roles)
    if (!own(org.roles, r) || !files.has(r))
      throw new OrgEditError(400, 'bad_request', `role ${r} not found`);
  for (const r of roles) {
    const list = own(org.roles, r)?.[key] ?? [];
    if (!list.includes(id)) setRoleList(files.get(r) as string, key, [...list, id]);
  }
}

/**
 * Makes the roles that list `id` under `key` exactly `roles`: added where missing, removed from
 * every other role (roles checked before anything is written).
 */
export function setAttachment(root: string, key: 'mcp' | 'skills', id: string, roles: string[]) {
  const org = loadOrg(root);
  const files = filesById(root, 'roles', 'role');
  for (const r of roles)
    if (!own(org.roles, r) || !files.has(r))
      throw new OrgEditError(400, 'bad_request', `role ${r} not found`);
  const want = new Set(roles);
  for (const [r, file] of files) {
    const list = own(org.roles, r)?.[key] ?? [];
    const has = list.includes(id);
    if (want.has(r) && !has) setRoleList(file, key, [...list, id]);
    else if (!want.has(r) && has)
      setRoleList(
        file,
        key,
        list.filter((x) => x !== id),
      );
  }
}
