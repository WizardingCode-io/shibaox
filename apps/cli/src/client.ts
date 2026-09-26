import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import {
  DaemonClient,
  DaemonUnavailableError,
  ensureDaemon,
  type HomePaths,
  homePaths,
} from '@shibaox/daemon';
import { CLI_VERSION } from './version.js';

export interface ConnectOptions {
  /** A read-only command tolerates an older daemon; a write command refuses it. */
  write?: boolean;
  log?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Starts `shibaox daemon start` detached, logging to the daemon log file. */
export function spawnDaemon(paths: HomePaths, env: NodeJS.ProcessEnv = process.env): void {
  const fd = openSync(paths.log, 'a');
  const child = spawn(process.execPath, [process.argv[1] as string, 'daemon', 'start'], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env,
  });
  child.unref();
}

const olderThan = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
};

/**
 * A client to the local daemon, starting it when it is not running (unless
 * `SHIBAOX_NO_AUTOSTART` is set). Explains itself when the daemon cannot be reached.
 */
export async function connect(o: ConnectOptions = {}): Promise<DaemonClient> {
  const env = o.env ?? process.env;
  const paths = homePaths(env);
  const log = o.log ?? ((l: string) => console.error(l));
  let client: DaemonClient;
  if (env.SHIBAOX_NO_AUTOSTART) {
    client = new DaemonClient(paths.socket);
    try {
      await client.health();
    } catch (e) {
      if (e instanceof DaemonUnavailableError)
        throw new Error(`No shibaox daemon is running. Start it with: shibaox daemon start`);
      throw e;
    }
  } else {
    try {
      client = await ensureDaemon({
        socketPath: paths.socket,
        spawn: () => spawnDaemon(paths, env),
        onSpawn: () => log(`Started the shibaox daemon (log: ${paths.log})`),
      });
    } catch (e) {
      if (
        e instanceof DaemonUnavailableError ||
        (e instanceof Error && /Could not start/.test(e.message))
      )
        throw new Error(`Could not start the shibaox daemon. See ${paths.log}`);
      throw e;
    }
  }
  const health = await client.health();
  if (olderThan(health.version, CLI_VERSION)) {
    const msg = `Daemon ${health.version} is older than this CLI (${CLI_VERSION}). Restart it: shibaox daemon stop && shibaox daemon start`;
    if (o.write) throw new Error(msg);
    log(`warn: ${msg}`);
  }
  return client;
}
