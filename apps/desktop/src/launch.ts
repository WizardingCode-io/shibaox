import type { Remote } from './paths.js';

export interface BridgeHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface StartResult {
  ok: boolean;
  /** Why the daemon could not be started (shown on the offline page). */
  reason?: string;
}

export interface LaunchDeps {
  /** `~/.shibaox/remote.json`, when there is one (or why it cannot be used). */
  remote(): Remote | { error: string } | undefined;
  /** Whether the local daemon answers on its socket. */
  probe(): Promise<boolean>;
  /** Starts the local daemon; `ok: false` when the start itself failed (nothing to wait for). */
  startDaemon(): Promise<StartResult>;
  /** The bridge on `port` (0 = any free port); rejects with `EADDRINUSE` when taken. */
  startBridge(port: number): Promise<BridgeHandle>;
  sleep(ms: number): Promise<void>;
  now?(): number;
  log?(line: string): void;
  /** Stable ports tried in order (a stable origin keeps the app's settings between launches). */
  candidatePorts?: number[];
  /** How long to wait (wall clock) for a daemon that was just started. */
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
 * (started here when it is not running), or the offline page saying what is wrong. Never
 * throws: whatever fails on the way is the offline page's reason.
 */
export async function planLaunch(d: LaunchDeps): Promise<Launch> {
  const log = d.log ?? (() => {});
  const now = d.now ?? Date.now;
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
    const started = await d.startDaemon();
    if (!started.ok)
      return {
        kind: 'offline',
        reason: started.reason ?? 'The shibaox daemon could not be started from here.',
      };
    const deadline = now() + (d.waitMs ?? 15_000);
    const stepMs = d.stepMs ?? 500;
    while (!alive && now() < deadline) {
      await d.sleep(stepMs);
      alive = await d.probe();
    }
  }
  if (!alive)
    return {
      kind: 'offline',
      reason:
        'The shibaox daemon was started but does not answer on its socket yet. Look at ~/.shibaox/daemon.log, then try again.',
    };
  try {
    const bridge = await openBridge(d, log);
    return { kind: 'bridge', url: bridge.url, bridge };
  } catch (e) {
    return {
      kind: 'offline',
      reason: `The app's local bridge could not listen: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
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

/** One run at a time: callers during a run get that run's promise; the next call after it runs again. */
export function single<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (!inFlight)
      inFlight = fn().finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
