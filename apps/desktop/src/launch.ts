import type { Remote } from './paths.js';

export interface BridgeHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface LaunchDeps {
  /** `~/.shibaox/remote.json`, when there is one (or why it cannot be used). */
  remote(): Remote | { error: string } | undefined;
  /** Whether the local daemon answers on its socket. */
  probe(): Promise<boolean>;
  /** Starts the local daemon (best effort; the socket is probed afterwards). */
  startDaemon(): Promise<void>;
  /** The bridge on `port` (0 = any free port); rejects with `EADDRINUSE` when taken. */
  startBridge(port: number): Promise<BridgeHandle>;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
  /** Stable ports tried in order (a stable origin keeps the app's settings between launches). */
  candidatePorts?: number[];
  /** How long to wait for a daemon that was just started. */
  waitMs?: number;
  stepMs?: number;
}

export type Launch =
  | { kind: 'remote'; url: string }
  | { kind: 'bridge'; url: string; bridge: BridgeHandle }
  | { kind: 'offline'; reason: string; url?: undefined };

/** 7434..7443: next to the daemon's own default port (7433), unlikely to be taken. */
export const DEFAULT_PORTS: number[] = Array.from({ length: 10 }, (_, i) => 7434 + i);

/**
 * Where the window goes: a remote daemon's own app, or the local daemon through the bridge
 * (started here when it is not running), or the offline page saying what is wrong.
 */
export async function planLaunch(d: LaunchDeps): Promise<Launch> {
  const log = d.log ?? (() => {});
  const remote = d.remote();
  if (remote && 'error' in remote) return { kind: 'offline', reason: remote.error };
  if (remote) {
    if (!remote.token)
      return {
        kind: 'offline',
        reason: `The remote daemon ${remote.baseUrl} has no token here: shibaox remote set ${remote.baseUrl} <token>`,
      };
    return { kind: 'remote', url: `${remote.baseUrl}/app/#token=${remote.token}` };
  }
  let alive = await d.probe();
  if (!alive) {
    log('the daemon is not running: starting it');
    await d.startDaemon();
    const waitMs = d.waitMs ?? 15_000;
    const stepMs = d.stepMs ?? 500;
    for (let waited = 0; !alive && waited < waitMs; waited += stepMs) {
      await d.sleep(stepMs);
      alive = await d.probe();
    }
  }
  if (!alive)
    return {
      kind: 'offline',
      reason:
        'The shibaox daemon is not running and could not be started from here. Start it in a terminal: shibaox daemon start (install it with npm i -g shibaox).',
    };
  const bridge = await openBridge(d, log);
  return { kind: 'bridge', url: bridge.url, bridge };
}

async function openBridge(d: LaunchDeps, log: (line: string) => void): Promise<BridgeHandle> {
  for (const port of d.candidatePorts ?? DEFAULT_PORTS) {
    try {
      return await d.startBridge(port);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
      log(`port ${port} is taken`);
    }
  }
  return d.startBridge(0);
}
