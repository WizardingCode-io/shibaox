import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$SHIBAOX_HOME`, else `~/.shibaox` (the same convention as the CLI and the daemon). */
export const homeRoot = (env: NodeJS.ProcessEnv = process.env): string =>
  env.SHIBAOX_HOME || join(env.HOME || homedir(), '.shibaox');

export const socketPath = (root: string): string => join(root, 'daemon.sock');

export interface Remote {
  baseUrl: string;
  token?: string;
}

/**
 * `~/.shibaox/remote.json` as `shibaox remote set` writes it. A file that cannot be used is
 * said (`{error}`), never skipped: skipping it would silently open the local daemon instead.
 */
export function readRemote(root: string): Remote | { error: string } | undefined {
  const file = join(root, 'remote.json');
  if (!existsSync(file)) return undefined;
  let raw: Partial<Remote>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Remote>;
  } catch {
    return { error: `${file} is not valid JSON: shibaox remote clear, then remote set again` };
  }
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl)
    return { error: `${file} has no baseUrl: shibaox remote clear, then remote set again` };
  let url: URL;
  try {
    url = new URL(raw.baseUrl);
  } catch {
    return { error: `${file}: the remote must be an http:// or https:// URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { error: `${file}: the remote must be an http:// or https:// URL` };
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    token: typeof raw.token === 'string' ? raw.token : undefined,
  };
}
