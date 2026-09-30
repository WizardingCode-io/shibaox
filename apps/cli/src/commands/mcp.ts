import { connect } from '../client.js';
import type { Out } from '../output.js';
import { resolveOrg } from './run.js';

/** `shibaox mcp list`: the org's MCP servers, who uses them, and the keys they miss. */
export async function mcpList(o: { org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const root = await resolveOrg(client, o.org);
  const rows = await client.mcpList(root);
  if (rows.length === 0) {
    out.line(`No MCP servers in ${root}/catalog (an entry with type: mcp and a server:).`);
    return 0;
  }
  for (const r of rows) {
    const missing = r.keys.filter((k) => !k.present).map((k) => k.name);
    const keys = r.keys.length
      ? missing.length
        ? `missing ${missing.join(', ')}`
        : 'keys set'
      : '';
    out.line(
      `${r.id.padEnd(16)} ${r.transport.padEnd(6)} ${r.target.slice(0, 48).padEnd(48)} roles: ${r.roles.join(', ') || '-'}${r.tools ? `  tools: ${r.tools.join(', ')}` : ''}${keys ? `  ${keys}` : ''}`,
    );
    out.obj(r);
  }
  return 0;
}

/** `shibaox mcp test <id>`: starts the server on the daemon and lists its tools. */
export async function mcpTest(id: string, o: { org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const root = await resolveOrg(client, o.org);
  const r = await client.mcpTest(id, root);
  out.obj({ id, ...r });
  if (!r.ok) {
    out.line(`${id}: ${r.error ?? 'failed'}`);
    return 1;
  }
  const tools = r.tools ?? [];
  out.line(`${id}: ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
  for (const t of tools) out.line(`  ${t.name.padEnd(28)} ${t.description.slice(0, 80)}`);
  return 0;
}
