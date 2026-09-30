import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homePaths } from '@wizardingcode/shibaox-daemon';

/** A daemon on another machine: where it listens and the bearer token it expects. */
export interface RemoteTarget {
  baseUrl: string;
  token?: string;
  /** `env`: SHIBAOX_REMOTE in the environment (or `--remote`); `file`: ~/.shibaox/remote.json. */
  source: 'env' | 'file';
}

/** What a token gives: said wherever one is stored or typed. */
export const TOKEN_WARNING =
  'A daemon token is shell access on that machine as the user running the daemon: keep it as you keep an SSH key.';

export const remoteFile = (root: string): string => join(root, 'remote.json');

/** `http://host:port` or `https://host/prefix`, without a trailing slash; anything else is refused. */
export function validateRemoteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`The remote must be an http:// or https:// URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`The remote must be an http:// or https:// URL, got ${JSON.stringify(raw)}`);
  if (url.search || url.hash)
    throw new Error('The remote URL takes no query or fragment: just scheme, host, port and path');
  if (url.username || url.password)
    throw new Error(
      'Put the token after the URL (shibaox remote set <url> <token>), not inside it',
    );
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Plain HTTP to another host sends the token in clear: worth a line every time it is set. */
export function insecureNote(baseUrl: string): string | undefined {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:' || LOOPBACK.has(url.hostname)) return undefined;
  return `${baseUrl} is plain HTTP: the token travels in clear. Reach it through an SSH tunnel or a VPN, or put TLS in front (daemon.yaml listen.tls).`;
}

interface RemoteFile {
  baseUrl: string;
  token?: string;
}

/** A remote.json that cannot be read is said, not skipped: skipping it would start a local daemon. */
function readRemoteFile(root: string): RemoteFile | undefined {
  const file = remoteFile(root);
  if (!existsSync(file)) return undefined;
  let raw: Partial<RemoteFile>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteFile>;
  } catch {
    throw new Error(`${file} is not valid JSON: shibaox remote clear, then remote set again`);
  }
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl)
    throw new Error(`${file} has no baseUrl: shibaox remote clear, then remote set again`);
  return {
    baseUrl: validateRemoteUrl(raw.baseUrl),
    token: typeof raw.token === 'string' ? raw.token : undefined,
  };
}

/**
 * Where commands go: `SHIBAOX_REMOTE` (with `SHIBAOX_REMOTE_TOKEN`, else the saved token when it
 * was saved for that same URL) wins, then `~/.shibaox/remote.json`; nothing means the local socket.
 */
export function remoteTarget(
  env: NodeJS.ProcessEnv,
  root: string = homePaths(env).root,
): RemoteTarget | undefined {
  const saved = readRemoteFile(root);
  if (env.SHIBAOX_REMOTE) {
    const baseUrl = validateRemoteUrl(env.SHIBAOX_REMOTE);
    return {
      baseUrl,
      // a token is for one daemon: the saved one never travels to another URL
      token: env.SHIBAOX_REMOTE_TOKEN || (saved?.baseUrl === baseUrl ? saved.token : undefined),
      source: 'env',
    };
  }
  if (saved) return { ...saved, source: 'file' };
  return undefined;
}

/** Writes remote.json readable by its owner only (also when it already existed); returns the file path. */
export function saveRemote(root: string, r: RemoteFile): string {
  mkdirSync(root, { recursive: true });
  const file = remoteFile(root);
  writeFileSync(file, `${JSON.stringify({ baseUrl: r.baseUrl, token: r.token }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(file, 0o600);
  return file;
}

/** Removes remote.json; false when there was none. */
export function clearRemote(root: string): boolean {
  const file = remoteFile(root);
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

/** `tok…`: enough to tell tokens apart, never the token. */
export const maskToken = (t: string | undefined): string | undefined =>
  t === undefined ? undefined : `${t.slice(0, 3)}…`;
