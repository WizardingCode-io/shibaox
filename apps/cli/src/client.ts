import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import {
  DaemonClient,
  DaemonHttpError,
  DaemonUnavailableError,
  ensureDaemon,
  type HomePaths,
  homePaths,
} from '@wizardingcode/shibaox-daemon';
import { type RemoteTarget, remoteTarget } from './remote.js';
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

/** What `restartOlderDaemon` talks to: health and shutdown of a daemon. */
export interface RestartableDaemon {
  health(): Promise<{ version: string; pid?: number; runs: { running: number } }>;
  shutdown(o?: { force?: boolean }): Promise<void>;
}

/**
 * A daemon older than this CLI is restarted here and now: shut down (it waits for its active
 * runs), then either the service starts it again (a new pid answers) or we spawn it. Says
 * what it did; says the way out when the one that comes back is still older (a service that
 * runs an older checkout).
 */
export async function restartOlderDaemon(o: {
  client: RestartableDaemon;
  cliVersion: string;
  spawn: () => void;
  log: (line: string) => void;
  /** Poll interval (tests shorten it). */
  pollMs?: number;
  /** How long to wait for the old one to go and the new one to answer (default 90 s). */
  timeoutMs?: number;
}): Promise<{ restarted: boolean; version: string }> {
  const first = await o.client.health();
  if (!olderThan(first.version, o.cliVersion)) return { restarted: false, version: first.version };
  o.log(`Daemon ${first.version} is older than this CLI (${o.cliVersion}): restarting it…`);
  await o.client.shutdown({});
  const poll = o.pollMs ?? 250;
  const until = Date.now() + (o.timeoutMs ?? 90_000);
  let spawned = false;
  let lastRunning = -1;
  while (Date.now() < until) {
    let h: Awaited<ReturnType<RestartableDaemon['health']>> | undefined;
    try {
      h = await o.client.health();
    } catch (e) {
      if (!(e instanceof DaemonUnavailableError)) throw e;
    }
    if (h && (h.pid === undefined || h.pid === first.pid) && h.version === first.version) {
      // the old one, still draining its runs
      if (h.runs.running !== lastRunning && h.runs.running > 0) {
        lastRunning = h.runs.running;
        o.log(`waiting for ${h.runs.running} active run(s) to finish…`);
      }
    } else if (h) {
      // a new daemon answers (the service restarted it, or ours)
      if (olderThan(h.version, o.cliVersion)) {
        o.log(
          `The daemon that came back is still ${h.version}: its service runs an older checkout. Run \`shibaox daemon install\` from this CLI (${o.cliVersion}) so the service uses it.`,
        );
        return { restarted: false, version: h.version };
      }
      o.log(`Daemon restarted (${h.version}).`);
      return { restarted: true, version: h.version };
    } else if (!spawned) {
      // gone: the service restarts it within a moment; if none does, we start it
      spawned = true;
      await new Promise((r) => setTimeout(r, poll * 4));
      try {
        await o.client.health();
        continue; // the service was faster
      } catch {
        o.spawn();
      }
    }
    await new Promise((r) => setTimeout(r, poll));
  }
  o.log('The daemon did not come back in time: shibaox daemon start');
  return { restarted: false, version: first.version };
}

/**
 * A client to the local daemon, starting it when it is not running (unless
 * `SHIBAOX_NO_AUTOSTART` is set). Explains itself when the daemon cannot be reached.
 */
export async function connect(o: ConnectOptions = {}): Promise<DaemonClient> {
  const env = o.env ?? process.env;
  const paths = homePaths(env);
  const log = o.log ?? ((l: string) => console.error(l));
  const remote = remoteTarget(env);
  if (remote) return connectRemote(remote, o, log);
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
    if (env.SHIBAOX_NO_AUTOSTART) {
      // tests and scripted use: no restarts behind the caller's back
      const msg = `Daemon ${health.version} is older than this CLI (${CLI_VERSION}). Restart it: shibaox daemon stop && shibaox daemon start`;
      if (o.write) throw new Error(msg);
      log(`warn: ${msg}`);
      return client;
    }
    const r = await restartOlderDaemon({
      client,
      cliVersion: CLI_VERSION,
      spawn: () => spawnDaemon(paths, env),
      log,
    });
    if (!r.restarted && o.write)
      throw new Error(`Daemon ${r.version} is older than this CLI (${CLI_VERSION}).`);
  }
  return client;
}

/**
 * A client to a daemon on another machine. Nothing is started or restarted from here: a remote
 * that does not answer, refuses the token or is older than this CLI is explained, not fixed.
 */
async function connectRemote(
  remote: RemoteTarget,
  o: ConnectOptions,
  log: (line: string) => void,
): Promise<DaemonClient> {
  const how =
    remote.source === 'env'
      ? 'SHIBAOX_REMOTE / --remote'
      : `shibaox remote set ${remote.baseUrl} <token>`;
  if (!remote.token)
    throw new Error(
      `The remote ${remote.baseUrl} is set but no token is: shibaox remote set ${remote.baseUrl} <token> (or SHIBAOX_REMOTE_TOKEN).`,
    );
  const client = new DaemonClient({ baseUrl: remote.baseUrl, token: remote.token });
  let health: Awaited<ReturnType<DaemonClient['health']>>;
  try {
    health = await client.health();
  } catch (e) {
    if (e instanceof DaemonUnavailableError)
      throw new Error(
        `No shibaox daemon answers at ${remote.baseUrl} (${how}). Is \`shibaox serve\` running there?`,
      );
    if (e instanceof DaemonHttpError && e.status === 401)
      throw new Error(
        `The daemon at ${remote.baseUrl} refused the token. Set the right one: shibaox remote set ${remote.baseUrl} <token>`,
      );
    throw e;
  }
  if (olderThan(health.version, CLI_VERSION)) {
    const msg = `Daemon ${health.version} at ${remote.baseUrl} is older than this CLI (${CLI_VERSION}): upgrade it there (shibaox upgrade, or npm i -g shibaox@latest, then restart shibaox serve).`;
    if (o.write) throw new Error(msg);
    log(`warn: ${msg}`);
  }
  return client;
}
