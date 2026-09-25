import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import { type CatalogEntry, CatalogEntrySchema } from './catalog.js';
import { type Gate, GateSchema } from './gate.js';
import { type Models, ModelsSchema } from './models.js';
import { type OrgFile, OrgFileSchema } from './org.js';
import { type Role, RoleSchema } from './role.js';
import { type Team, TeamSchema } from './team.js';
import { type Workflow, WorkflowSchema } from './workflow.js';

export interface Org {
  root: string;
  org: OrgFile;
  models: Models;
  teams: Record<string, Team>;
  roles: Record<string, Role>;
  workflows: Record<string, Workflow>;
  gates: Record<string, Gate>;
  catalog: Record<string, CatalogEntry>;
}

export class OrgLoadError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'OrgLoadError';
  }
}

function readYamlFile<T>(root: string, rel: string, schema: ZodType<T>): T {
  const file = join(root, rel);
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new OrgLoadError(relative(root, file), (e as Error).message);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new OrgLoadError(rel, msg);
  }
  return result.data;
}

function readDir<T extends Record<string, unknown>>(
  root: string,
  sub: string,
  schema: ZodType<T>,
  key: keyof T & string,
): Record<string, T> {
  const dir = join(root, sub);
  if (!existsSync(dir)) return {};
  const out: Record<string, T> = {};
  for (const name of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const item = readYamlFile(root, join(sub, name), schema);
    out[String(item[key])] = item;
  }
  return out;
}

export function loadOrg(root: string): Org {
  if (!existsSync(join(root, 'org.yaml'))) throw new OrgLoadError('org.yaml', 'file not found');
  const org = readYamlFile(root, 'org.yaml', OrgFileSchema);
  const models = existsSync(join(root, 'models.yaml'))
    ? readYamlFile(root, 'models.yaml', ModelsSchema)
    : ModelsSchema.parse({});
  const teams = readDir(root, 'teams', TeamSchema, 'team');
  const roles = readDir(root, 'roles', RoleSchema, 'role');
  const workflows = readDir(root, 'workflows', WorkflowSchema, 'workflow');
  const gates = readDir(root, 'gates', GateSchema, 'gate');
  const catalog = readDir(root, 'catalog', CatalogEntrySchema, 'id');

  for (const t of org.teams) {
    if (!teams[t]) throw new OrgLoadError('org.yaml', `team "${t}" has no file in teams/`);
  }
  for (const [name, team] of Object.entries(teams)) {
    const file = `teams/${name}.yaml`;
    if (!roles[team.lead])
      throw new OrgLoadError(file, `lead role "${team.lead}" is not defined in roles/`);
    for (const r of team.roles)
      if (!roles[r]) throw new OrgLoadError(file, `role "${r}" is not defined in roles/`);
    for (const g of team.gates)
      if (!gates[g]) throw new OrgLoadError(file, `gate "${g}" is not defined in gates/`);
    for (const w of team.workflows)
      if (!workflows[w])
        throw new OrgLoadError(file, `workflow "${w}" is not defined in workflows/`);
  }
  for (const [name, wf] of Object.entries(workflows)) {
    const file = `workflows/${name}.yaml`;
    if (wf.team && !teams[wf.team])
      throw new OrgLoadError(file, `team "${wf.team}" is not defined`);
    for (const [id, node] of Object.entries(wf.nodes)) {
      if (node.type === 'task' && !roles[node.role])
        throw new OrgLoadError(file, `node "${id}" uses role "${node.role}" which is not defined`);
      if (node.type === 'gate')
        for (const g of node.gates)
          if (!gates[g])
            throw new OrgLoadError(file, `node "${id}" uses gate "${g}" which is not defined`);
    }
  }
  return { root, org, models, teams, roles, workflows, gates, catalog };
}
