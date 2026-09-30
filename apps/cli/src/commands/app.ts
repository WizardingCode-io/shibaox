import { spawn } from 'node:child_process';
import {
  type DaemonClient,
  homePaths,
  resolveAppDist,
  SecretsStore,
} from '@wizardingcode/shibaox-daemon';
import { startBridge } from '../bridge.js';
import { connect } from '../client.js';
import type { Out } from '../output.js';
import { remoteTarget } from '../remote.js';

/** Opens `url` in the default browser (best effort; the address is always printed too). */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // no opener here: the address was printed
  }
}

/**
 * `shibaox app`: the browser app. A remote daemon or a local one with a network listener
 * serves it itself (the token goes in the URL fragment); a socket-only daemon gets a
 * loopback bridge with a token of its own that stays up until Ctrl-C.
 */
export async function appCommand(
  o: { open?: boolean; port?: number; env?: NodeJS.ProcessEnv; wait?: () => Promise<void> },
  out: Out,
): Promise<number> {
  const env = o.env ?? process.env;
  const open = o.open !== false;
  const remote = remoteTarget(env);
  if (remote) {
    if (!remote.token) {
      out.line('The remote daemon has no token here: shibaox remote set <url> <token>');
      return 1;
    }
    const url = `${remote.baseUrl.replace(/\/+$/, '')}/app/#token=${remote.token}`;
    out.line(`The app of ${remote.baseUrl}: ${url}`);
    out.obj({ url, via: 'remote' });
    if (open) openBrowser(url);
    return 0;
  }
  const paths = homePaths(env);
  const client = await connect({ env });
  const health = await client.health();
  if (health.listen) {
    const token =
      env.SHIBAOX_DAEMON_TOKEN || new SecretsStore(paths.secrets).get('SHIBAOX_DAEMON_TOKEN');
    if (!token) {
      const why =
        'The daemon listens on the network but its token is not here: set SHIBAOX_DAEMON_TOKEN in the environment or shibaox keys set SHIBAOX_DAEMON_TOKEN <token>';
      console.error(why);
      out.obj({ error: why });
      return 1;
    }
    const scheme = health.listen.tls ? 'https' : 'http';
    const host =
      health.listen.host === '0.0.0.0' || health.listen.host === '::'
        ? '127.0.0.1'
        : health.listen.host;
    const url = `${scheme}://${host}:${health.listen.port}/app/#token=${token}`;
    out.line(`The app: ${url}`);
    out.obj({ url, via: 'listener' });
    if (open) openBrowser(url);
    return 0;
  }
  const bridge = await startBridge({
    socketPath: paths.socket,
    dist: resolveAppDist(import.meta.url),
    port: o.port,
  });
  out.line(`The app: ${bridge.url}`);
  out.line(
    'This address works while this command runs (Ctrl-C to stop). The token in it is for this session only.',
  );
  out.obj({ url: bridge.url, via: 'bridge' });
  if (open) openBrowser(bridge.url);
  await (
    o.wait ?? (() => new Promise<void>((resolve) => process.once('SIGINT', () => resolve())))
  )();
  await bridge.close();
  return 0;
}

export type { DaemonClient };
