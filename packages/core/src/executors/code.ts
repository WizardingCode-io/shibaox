import { spawn } from 'node:child_process';

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Merge `process.env` under `env` (default true). When false the child sees only `env`. */
  inheritEnv?: boolean;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCommand(opts: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      shell: true,
      env: opts.inheritEnv === false ? { ...opts.env } : { ...process.env, ...opts.env },
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // process already exited between the timer firing and the kill call
      }
    }, opts.timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
  });
}
