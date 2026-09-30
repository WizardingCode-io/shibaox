import { homePaths } from '@wizardingcode/shibaox-daemon';
import type { Out } from '../output.js';
import {
  clearRemote,
  insecureNote,
  maskToken,
  remoteTarget,
  saveRemote,
  TOKEN_WARNING,
  validateRemoteUrl,
} from '../remote.js';

/** Reads the token from the argument, else from a piped stdin. */
async function tokenFrom(arg: string | undefined): Promise<string | undefined> {
  if (arg !== undefined) return arg;
  if (process.stdin.isTTY) return undefined;
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.trim() || undefined;
}

/** `shibaox remote set <url> [token]`: every command goes to that daemon from now on. */
export async function remoteSet(url: string, arg: string | undefined, out: Out): Promise<number> {
  let baseUrl: string;
  try {
    baseUrl = validateRemoteUrl(url);
  } catch (e) {
    out.line(e instanceof Error ? e.message : String(e));
    out.obj({ set: false, error: e instanceof Error ? e.message : String(e) });
    return 1;
  }
  const token = await tokenFrom(arg);
  if (!token) {
    out.line(
      'A token is required: shibaox remote set <url> <token>, or pipe it on stdin. It is the SHIBAOX_DAEMON_TOKEN the daemon was started with.',
    );
    out.obj({ set: false, error: 'no token' });
    return 1;
  }
  const file = saveRemote(homePaths().root, { baseUrl, token });
  out.line(`Commands now go to ${baseUrl} (saved in ${file}, readable by you only).`);
  out.line(TOKEN_WARNING);
  const note = insecureNote(baseUrl);
  if (note) out.line(note);
  out.line('Back to the local daemon: shibaox remote clear');
  out.obj({ set: true, baseUrl, file, insecure: Boolean(note) });
  return 0;
}

/** `shibaox remote show`: where commands go, with the token masked. */
export function remoteShow(out: Out): number {
  const env = process.env;
  const r = remoteTarget(env);
  if (!r) {
    out.line('No remote: commands go to the local daemon (shibaox remote set <url> <token>).');
    out.obj({ remote: false });
    return 0;
  }
  out.line(
    `${r.baseUrl} (${r.source === 'env' ? 'from SHIBAOX_REMOTE' : 'from ~/.shibaox/remote.json'}${r.token ? `, token ${maskToken(r.token)}` : ', no token'})`,
  );
  out.obj({ baseUrl: r.baseUrl, token: maskToken(r.token), source: r.source });
  return 0;
}

/** `shibaox remote clear`: back to the local daemon. */
export function remoteClear(out: Out): number {
  const removed = clearRemote(homePaths().root);
  out.line(
    removed
      ? 'Commands go to the local daemon again.'
      : 'No remote was set: commands already go to the local daemon.',
  );
  if (process.env.SHIBAOX_REMOTE)
    out.line(`SHIBAOX_REMOTE is still set in this shell (${process.env.SHIBAOX_REMOTE}).`);
  out.obj({ cleared: removed });
  return 0;
}
