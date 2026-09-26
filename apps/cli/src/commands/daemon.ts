import { existsSync, readFileSync } from 'node:fs';
import { Daemon, DaemonClient, DaemonUnavailableError, homePaths } from '@shibaox/daemon';
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
  out.obj({ stopped: true });
  return 0;
}

export async function daemonStatus(out: Out): Promise<number> {
  const paths = homePaths();
  let client: DaemonClient;
  try {
    client = await connect({ env: { ...process.env, SHIBAOX_NO_AUTOSTART: '1' }, log: () => {} });
  } catch {
    out.line(`No shibaox daemon is running (socket: ${paths.socket}).`);
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
  out.line(`socket: ${paths.socket}`);
  out.obj({ running: true, pid, socket: paths.socket, ...h });
  return 0;
}
