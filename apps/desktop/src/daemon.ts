import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import type { StartResult } from './launch.js';

/** `GET /health` over the socket: true when a daemon answers. */
export function probeDaemon(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path: '/health', method: 'GET', timeout: timeoutMs }, (r) => {
      r.resume();
      resolve((r.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** The launchd service `shibaox daemon install` writes. */
const LAUNCHD_LABEL = 'io.shibaox.daemon';

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', env });
    } catch {
      return resolve(127);
    }
    const timer = setTimeout(() => {
      child.kill();
      resolve(124);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(127);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

/**
 * Starts the daemon the way the user's own setup would: the launchd service when it is
 * installed, else the installer's launcher (`~/.shibaox/bin/shibaox`), else `shibaox daemon
 * start --detach` through an interactive login shell (a GUI app has a bare PATH; `-ilc` reads
 * .zprofile and .zshrc, where nvm and npm put theirs). `--detach` writes ~/.shibaox/daemon.log,
 * refuses to start a second daemon, and exits at once.
 */
export async function startDaemonViaShell(
  env: NodeJS.ProcessEnv = process.env,
  root: string = join(env.HOME || '', '.shibaox'),
): Promise<StartResult> {
  const home = env.HOME || '';
  if (
    process.platform === 'darwin' &&
    existsSync(join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`))
  ) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const code = await run('launchctl', ['kickstart', `gui/${uid}/${LAUNCHD_LABEL}`], env, 10_000);
    if (code === 0) return { ok: true };
  }
  const launcher = join(root, 'bin', 'shibaox');
  if (existsSync(launcher)) {
    const code = await run(launcher, ['daemon', 'start', '--detach'], env, 60_000);
    return code === 0
      ? { ok: true }
      : {
          ok: false,
          reason: `${launcher} daemon start --detach exited with ${code}: see ${join(root, 'daemon.log')}`,
        };
  }
  const shell = env.SHELL || '/bin/zsh';
  const code = await run(shell, ['-ilc', 'exec shibaox daemon start --detach'], env, 60_000);
  if (code === 0) return { ok: true };
  return {
    ok: false,
    reason:
      code === 127
        ? `shibaox is not in the PATH of ${shell}: npm i -g shibaox, or start the daemon in a terminal (shibaox daemon start --detach) and try again`
        : `${shell} -ilc 'shibaox daemon start --detach' exited with ${code}: see ${join(root, 'daemon.log')}`,
  };
}
