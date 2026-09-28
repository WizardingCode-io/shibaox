import { existsSync, readFileSync } from 'node:fs';
import { runArgv } from '@wizardingcode/shibaox-core';
import {
  Daemon,
  DaemonClient,
  DaemonUnavailableError,
  type HomePaths,
  homePaths,
  installService,
  loadDaemonConfig,
  SecretsStore,
  type ServiceArgs,
  servicePaths,
  servicePredatesLauncher,
  serviceStatus,
  uninstallService,
} from '@wizardingcode/shibaox-daemon';
import { connect, spawnDaemon } from '../client.js';
import type { Out } from '../output.js';
import { CLI_VERSION } from '../version.js';

/** `shibaox daemon start`: foreground by default, detached with `--detach`. */
export async function daemonStart(o: { detach?: boolean }, out: Out): Promise<number> {
  const paths = homePaths();
  if (o.detach) {
    const probe = new DaemonClient(paths.socket);
    const running = await probe.health().then(
      () => true,
      (e: unknown) => !(e instanceof DaemonUnavailableError),
    );
    if (running) {
      out.line('The shibaox daemon is already running.');
      out.obj({ started: false, socket: paths.socket });
      return 0;
    }
    spawnDaemon(paths);
    out.line(`Started the shibaox daemon (log: ${paths.log})`);
    out.obj({ started: true, socket: paths.socket, log: paths.log });
    return 0;
  }
  const daemon = new Daemon({
    version: CLI_VERSION,
    log: (l) => console.log(`${new Date().toISOString()} ${l}`),
  });
  await daemon.start();
  console.log(`shibaox daemon ${CLI_VERSION} listening on ${paths.socket}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      console.log('Stopping the shibaox daemon...');
      void daemon.stop().then(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

export async function daemonStop(o: { force?: boolean }, out: Out): Promise<number> {
  const paths = homePaths();
  const client = new DaemonClient(paths.socket);
  try {
    await client.shutdown({ force: o.force });
  } catch (e) {
    if (e instanceof DaemonUnavailableError) {
      out.line('No shibaox daemon is running.');
      out.obj({ stopped: false });
      return 0;
    }
    throw e;
  }
  out.line(
    o.force
      ? 'Stopping the daemon and cancelling active runs.'
      : 'Stopping the daemon after active runs finish.',
  );
  // stay until it is gone: say how many runs it is waiting for, then that it stopped. A
  // daemon launchd restarted meanwhile answers with another pid: that one is the new one.
  const oldPid = existsSync(paths.pid) ? readFileSync(paths.pid, 'utf8').trim() : undefined;
  let lastRunning = -1;
  const until = Date.now() + 3 * 60_000;
  let stopped = false;
  while (Date.now() < until) {
    let h: { runs: { running: number }; pid?: number } | undefined;
    try {
      h = await client.health();
    } catch (e) {
      if (e instanceof DaemonUnavailableError) {
        stopped = true;
        break;
      }
      throw e;
    }
    if (h.pid !== undefined && oldPid !== undefined && String(h.pid) !== oldPid) {
      stopped = true; // launchd already started the next one
      break;
    }
    if (h.runs.running !== lastRunning) {
      lastRunning = h.runs.running;
      if (h.runs.running > 0)
        out.line(
          `waiting for ${h.runs.running} active run(s) to finish (up to 60 s, then they are interrupted and resumed at the next start; \`--force\` cancels them)…`,
        );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  out.line(
    stopped ? 'Stopped.' : 'Still running after 3 minutes: `daemon stop --force` cancels the runs.',
  );
  if ((await serviceStatus()) === 'installed')
    out.line(
      'The launchd service will start it again; run `shibaox daemon uninstall` to stop that.',
    );
  out.obj({ stopped: true });
  return 0;
}

/** `service: launchd (installed)` / `not loaded` / `not installed`. */
export async function serviceLine(a: ServiceArgs = {}): Promise<string> {
  const s = await serviceStatus(a);
  return `service: ${s === 'installed' ? 'launchd (installed)' : s === 'not-loaded' ? 'launchd (plist present, not loaded)' : 'not installed'}`;
}

/** Stops a detached daemon when one answers; false when none is running. */
async function stopDetached(paths: HomePaths): Promise<boolean> {
  const client = new DaemonClient(paths.socket);
  try {
    await client.shutdown({});
  } catch (e) {
    if (e instanceof DaemonUnavailableError) return false;
    throw e;
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const up = await client.health().then(
      () => true,
      () => false,
    );
    if (!up) break;
  }
  return true;
}

export interface ServiceDeps extends ServiceArgs {
  paths?: HomePaths;
  /** Stops a detached daemon first (launchd owns it from now on); returns whether one ran. */
  stopRunning?: () => Promise<boolean>;
}

/** What `status` and `doctor` say about an installed service whose launcher or paths went stale. */
export async function staleServiceHint(paths: HomePaths): Promise<string | undefined> {
  if ((await serviceStatus()) === 'not-installed') return undefined;
  if (servicePredatesLauncher(paths))
    return 'service: installed before the launcher (an absolute node path): run `shibaox daemon install` once so a Node upgrade cannot strand it';
  const sp = servicePaths(paths);
  if (sp?.stale)
    return `service: the launcher records ${existsSync(sp.node) ? sp.cli : sp.node}, which is gone (Node upgraded?): run \`shibaox daemon install\` again`;
  return undefined;
}

/** `shibaox daemon install`: a launchd agent that keeps the daemon running across logins. */
export async function daemonInstall(out: Out, d: ServiceDeps = {}): Promise<number> {
  if (process.platform !== 'darwin' && !d.exec) {
    out.line('The service is available on macOS (launchd) for now.');
    out.obj({ installed: false, reason: 'unsupported platform' });
    return 1;
  }
  const paths = d.paths ?? homePaths();
  const stopped = await (d.stopRunning ?? (() => stopDetached(paths)))();
  if (stopped) out.line('Stopped the running daemon: launchd takes over from here.');
  const { plist } = await installService({
    paths,
    node: process.execPath,
    cli: process.argv[1] as string,
    env: d.env,
    exec: d.exec,
    uid: d.uid,
  });
  out.line(`Installed the launchd service (${plist}); it starts now and at every login.`);
  out.line(`Log: ${paths.log}`);
  const missing = await hiddenFromLoginShell(d.env ?? process.env, d.exec ?? runArgv);
  if (missing.length > 0)
    out.line(
      `Note: a login shell does not see ${missing.join(', ')} (exported in ~/.zshrc?). The service reads ~/.zprofile or ~/.zshenv: move the export there, then \`shibaox daemon install\` again.`,
    );
  out.obj({ installed: true, plist, log: paths.log, hiddenEnv: missing });
  return 0;
}

/** The keys this shell has that `/bin/zsh -lc` (what launchd runs) would not: `.zshrc`-only exports. */
export async function hiddenFromLoginShell(
  env: NodeJS.ProcessEnv,
  exec: typeof runArgv,
): Promise<string[]> {
  const tokenEnv = (() => {
    try {
      return loadDaemonConfig(homePaths(env).config).channels.telegram?.bot_token_env;
    } catch {
      return undefined;
    }
  })();
  // keys in the shibaox vault reach the service whatever the shell does
  const vault = new SecretsStore(homePaths(env).secrets);
  const names = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'TYPESAFE_API_KEY',
    tokenEnv ?? 'SHIBAOX_TELEGRAM_TOKEN',
  ].filter((n) => env[n] && !vault.get(n));
  const missing: string[] = [];
  for (const name of names) {
    const r = await exec({
      argv: ['/bin/zsh', '-lc', `printenv ${name}`],
      cwd: '/',
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0 || !r.stdout.trim()) missing.push(name);
  }
  return missing;
}

export async function daemonUninstall(out: Out, d: ServiceDeps = {}): Promise<number> {
  const paths = d.paths ?? homePaths();
  await uninstallService({ paths, env: d.env, exec: d.exec, uid: d.uid });
  out.line(
    'Service removed; the daemon is stopped (start it again with `shibaox daemon start --detach`).',
  );
  out.obj({ installed: false });
  return 0;
}

export async function daemonStatus(out: Out): Promise<number> {
  const paths = homePaths();
  let client: DaemonClient;
  const serviceHint = await staleServiceHint(paths);
  try {
    client = await connect({ env: { ...process.env, SHIBAOX_NO_AUTOSTART: '1' }, log: () => {} });
  } catch {
    out.line(`No shibaox daemon is running (socket: ${paths.socket}).`);
    if (serviceHint) out.line(serviceHint);
    out.obj({ running: false, socket: paths.socket });
    return 1;
  }
  const h = await client.health();
  const pid = existsSync(paths.pid) ? readFileSync(paths.pid, 'utf8').trim() : undefined;
  out.line(
    `shibaox daemon version ${h.version}${pid ? ` (pid ${pid})` : ''}, up ${h.uptimeSeconds}s`,
  );
  out.line(`runs: ${h.runs.running} running, ${h.runs.queued} queued`);
  out.line(`channels: ${h.channels.length ? h.channels.join(', ') : 'none'}`);
  if (serviceHint) out.line(serviceHint);
  const service = await serviceStatus();
  out.line(
    `service: ${service === 'installed' ? 'launchd (installed)' : service === 'not-loaded' ? 'launchd (plist present, not loaded)' : 'not installed'}`,
  );
  out.line(`socket: ${paths.socket}`);
  out.obj({ running: true, pid, socket: paths.socket, service, ...h });
  return 0;
}
