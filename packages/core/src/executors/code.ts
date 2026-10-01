import { spawn } from 'node:child_process';

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  /** Merge `process.env` under `env` (default true). When false the child sees only `env`. */
  inheritEnv?: boolean;
  /** Kills the process group when aborted (the result has `aborted: true`). */
  signal?: AbortSignal;
  /** Keeps at most this many bytes of stderr (the rest is dropped; the process goes on). */
  maxStderrBytes?: number;
  /** Kills the process group once stdout passes this many bytes (the result has `overflow: true`). */
  maxStdoutBytes?: number;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed because stdout passed `maxStdoutBytes`. */
  overflow?: boolean;
  /** Killed by `signal`. */
  aborted?: boolean;
}

export interface ArgvOptions extends Omit<CommandOptions, 'command'> {
  /** Program and arguments; spawned directly, without a shell (no expansion, no operators). */
  argv: string[];
}

/** Runs `command` through a shell (gate `code` checks and `code` nodes: trusted org config). */
export function runCommand(opts: CommandOptions): Promise<CommandResult> {
  return spawnAndCollect(opts.command, [], true, opts);
}

/** Runs `argv[0]` with `argv.slice(1)` without a shell; same timeout, kill and env semantics. */
export function runArgv(opts: ArgvOptions): Promise<CommandResult> {
  const [program, ...args] = opts.argv;
  if (!program)
    return Promise.resolve({ exitCode: null, stdout: '', stderr: 'empty argv', timedOut: false });
  return spawnAndCollect(program, args, false, opts);
}

function spawnAndCollect(
  program: string,
  args: string[],
  shell: boolean,
  opts: Omit<CommandOptions, 'command'>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const options = {
      cwd: opts.cwd,
      shell,
      env: opts.inheritEnv === false ? { ...opts.env } : { ...process.env, ...opts.env },
      detached: process.platform !== 'win32',
      // no stdin: a program that asks a question ends instead of waiting the whole timeout
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    };
    // never pass an args array together with shell: true (Node DEP0190)
    const child = shell ? spawn(program, options) : spawn(program, args, options);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let aborted = false;
    const killGroup = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // process already exited between the trigger and the kill call
      }
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (overflow) return;
      stdout += d.toString();
      if (opts.maxStdoutBytes !== undefined && stdout.length > opts.maxStdoutBytes) {
        overflow = true;
        killGroup();
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      const max = opts.maxStderrBytes;
      if (max !== undefined && stderr.length >= max) return;
      stderr += d.toString();
      if (max !== undefined && stderr.length > max) stderr = stderr.slice(0, max);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const extra = () => ({ ...(overflow ? { overflow } : {}), ...(aborted ? { aborted } : {}) });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code, stdout, stderr, timedOut, ...extra() });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: null, stdout, stderr: `${stderr}${err.message}`, timedOut, ...extra() });
    });
  });
}
