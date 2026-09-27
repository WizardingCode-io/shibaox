import { connect } from '../client.js';
import type { Out } from '../output.js';

/** `shibaox keys list`: every key shibaox knows, where it comes from, masked. */
export async function keysList(out: Out): Promise<number> {
  const client = await connect();
  const rows = await client.keys();
  for (const r of rows) {
    out.line(
      `${r.set ? 'set ' : '    '} ${r.name.padEnd(30)} ${r.set ? `${r.masked ?? ''} (${r.source})`.padEnd(24) : 'missing'.padEnd(24)} ${r.description}`,
    );
    out.obj(r);
  }
  out.line('');
  out.line(
    'Set one with: shibaox keys set NAME VALUE   (or pipe the value: echo VALUE | shibaox keys set NAME)',
  );
  return 0;
}

/** Reads the value from the argument, else from a piped stdin. */
async function valueFrom(arg: string | undefined): Promise<string | undefined> {
  if (arg !== undefined) return arg;
  if (process.stdin.isTTY) return undefined;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() || undefined;
}

export async function keysSet(name: string, arg: string | undefined, out: Out): Promise<number> {
  const value = await valueFrom(arg);
  if (!value) {
    out.line(`No value given: shibaox keys set ${name} VALUE, or pipe it on stdin.`);
    out.obj({ name, set: false, error: 'no value' });
    return 1;
  }
  const client = await connect({ write: true });
  await client.setKey(name, value);
  out.line(`Saved ${name} in the shibaox vault; the daemon uses it from now on.`);
  out.obj({ name, set: true });
  return 0;
}

export async function keysUnset(name: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const r = await client.unsetKey(name);
  out.line(r.removed ? `Removed ${name} from the vault.` : `${name} was not in the vault.`);
  out.obj(r);
  return 0;
}
