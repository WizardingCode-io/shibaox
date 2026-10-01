import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DaemonHttpError,
  type McpAddRequest,
  type SkillAddRequest,
} from '@wizardingcode/shibaox-daemon';
import type { McpServerInput } from '@wizardingcode/shibaox-schemas';
import { connect } from '../client.js';
import type { Out } from '../output.js';
import { resolveOrg } from './run.js';

/** `shibaox skills list`: the org's skills and the roles that use them. */
export async function skillsList(o: { org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const root = await resolveOrg(client, o.org);
  const rows = await client.skills(root);
  if (rows.length === 0) out.line(`No skills in ${root}/skills (a folder with a SKILL.md).`);
  for (const r of rows) {
    out.line(
      `${r.id.padEnd(22)} ${r.description.slice(0, 60).padEnd(60)} ${r.roles.length ? `used by: ${r.roles.join(', ')}` : 'not used by any role'}`,
    );
    out.obj(r);
  }
  return 0;
}

/**
 * What `skills add <source>` means: an existing directory is a folder (copied by the daemon on
 * this machine); `owner/repo[/path]` or a git URL is a repository.
 */
export function skillSource(source: string, o: { id?: string[]; path?: string }): SkillAddRequest {
  if (existsSync(source) && statSync(source).isDirectory())
    return { source: 'folder', path: resolve(source) };
  const gh = /^([a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)(?:\/(.+))?$/i.exec(source);
  const repo = gh ? (gh[1] as string) : source;
  const path = o.path ?? gh?.[2];
  return {
    source: 'repo',
    repo,
    ...(path ? { path } : {}),
    ...(o.id?.length ? { ids: o.id } : {}),
  };
}

/** `shibaox skills add <repo|path>`: installs every skill found (or the `--id` ones). */
export async function skillsAdd(
  source: string,
  o: { org?: string; id?: string[]; path?: string },
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const root = await resolveOrg(client, o.org);
  const r = await client.addSkills(root, skillSource(source, o));
  for (const a of r.added) out.line(`added ${a.id}  ${a.path}`);
  for (const s of r.skipped) out.line(`skipped ${s.id} (${s.reason})`);
  if (r.added.length === 0 && r.skipped.length === 0) out.line('No SKILL.md found there.');
  if (r.added.length)
    out.line(
      'Give a skill to a role with skills: [id] in its file, or from the app (Customize → Skills).',
    );
  out.obj(r);
  return r.added.length || r.skipped.length ? 0 : 1;
}

/** `shibaox skills rm <id>`: refused while roles use it unless `--detach`. */
export async function skillsRemove(
  id: string,
  o: { org?: string; detach?: boolean },
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const root = await resolveOrg(client, o.org);
  try {
    out.obj(await client.removeSkill(root, id, { detach: o.detach }));
    out.line(`Removed skill ${id}.`);
    return 0;
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 409) {
      const roles = (e.details?.roles as string[] | undefined) ?? [];
      out.line(
        `${id} is used by ${roles.join(', ')}: run again with --detach to take it off those roles.`,
      );
      out.obj({ id, removed: false, roles });
      return 1;
    }
    throw e;
  }
}

/** `K=V` (the first `=` splits). */
function headerPairs(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    const i = h.indexOf('=');
    if (i <= 0) throw new Error(`--header takes NAME=VALUE (got "${h}")`);
    out[h.slice(0, i).trim()] = h.slice(i + 1);
  }
  return out;
}

export interface McpAddOptions {
  org?: string;
  url?: string;
  command?: string;
  arg?: string[];
  key?: string[];
  header?: string[];
  bearerCommand?: string;
  tool?: string[];
  role?: string[];
  description?: string;
  timeout?: number;
  replace?: boolean;
}

/** The request `mcp add` sends (exported for tests). */
export function mcpAddRequest(id: string, o: McpAddOptions): McpAddRequest {
  if (!!o.url === !!o.command) throw new Error('give either --url (http) or --command (stdio)');
  const common: Partial<McpServerInput> = {
    ...(o.key?.length ? { env_keys: o.key } : {}),
    ...(o.tool?.length ? { tools: o.tool } : {}),
    ...(o.timeout ? { timeout_ms: o.timeout } : {}),
  };
  const server: McpServerInput = o.url
    ? {
        transport: 'http',
        url: o.url,
        ...common,
        ...(o.header?.length ? { headers: headerPairs(o.header) } : {}),
        ...(o.bearerCommand
          ? { bearer_command: o.bearerCommand.split(/\s+/).filter(Boolean) }
          : {}),
      }
    : {
        transport: 'stdio',
        command: o.command,
        ...(o.arg?.length ? { args: o.arg } : {}),
        ...common,
      };
  return {
    id,
    description: o.description ?? `${id} (MCP server)`,
    server,
    ...(o.role?.length ? { roles: o.role } : {}),
    ...(o.replace ? { replace: true } : {}),
  };
}

/** `shibaox mcp add <id>`: writes catalog/<id>.yaml through the daemon and attaches roles. */
export async function mcpAdd(id: string, o: McpAddOptions, out: Out): Promise<number> {
  const req = mcpAddRequest(id, o);
  const client = await connect({ write: true });
  const root = await resolveOrg(client, o.org);
  try {
    const r = await client.addMcp(root, req);
    const missing = r.keys.filter((k) => !k.present).map((k) => k.name);
    out.line(
      `${r.id}  ${r.transport}  ${r.target}  roles: ${r.roles.join(', ') || '-'}${missing.length ? `  missing ${missing.join(', ')} (shibaox keys set NAME)` : ''}`,
    );
    out.obj(r);
    return 0;
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 409) {
      out.line(`${e.message}: run again with --replace to overwrite it.`);
      out.obj({ id, added: false, error: e.message });
      return 1;
    }
    throw e;
  }
}

/** `shibaox mcp rm <id>`: detaches it from every role, then deletes the catalog entry. */
export async function mcpRemove(id: string, o: { org?: string }, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const root = await resolveOrg(client, o.org);
  out.obj(await client.removeMcp(root, id));
  out.line(`Removed ${id} from the catalog and from every role.`);
  return 0;
}

/** `shibaox roles list`: each role's model, MCP servers and skills. */
export async function rolesList(o: { org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const root = await resolveOrg(client, o.org);
  for (const r of await client.roles(root)) {
    out.line(
      `${r.id.padEnd(16)} ${(r.model ?? '').padEnd(28)} mcp: ${r.mcp.join(', ') || '-'}  skills: ${r.skills.join(', ') || '-'}`,
    );
    out.obj(r);
  }
  return 0;
}

/** `shibaox plugins`: Higgsfield, GitHub, Telegram, TypeSafe / Jev, what passes and what does not. */
export async function pluginsCommand(out: Out): Promise<number> {
  const client = await connect();
  for (const p of await client.plugins()) {
    out.line(`${p.id.padEnd(12)} ${p.status.padEnd(8)} ${p.name}`);
    for (const c of p.checks)
      out.line(`    ${c.ok ? 'ok ' : 'no '} ${c.label}${c.detail ? `  (${c.detail})` : ''}`);
    out.obj(p);
  }
  return 0;
}
