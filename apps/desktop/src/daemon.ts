import { spawn } from 'node:child_process';
import { request } from 'node:http';

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

/**
 * `shibaox daemon start` through a login shell: a GUI app on macOS gets a bare PATH, the login
 * shell brings the user's (npm global bin, homebrew, nvm...). The daemon outlives this process.
 */
export function startDaemonViaShell(env: NodeJS.ProcessEnv = process.env): void {
  const shell = env.SHELL || '/bin/sh';
  try {
    const child = spawn(shell, ['-lc', 'exec shibaox daemon start'], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no shell to run: the probe will say the daemon is still down
  }
}
