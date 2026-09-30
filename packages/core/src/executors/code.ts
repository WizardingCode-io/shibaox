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
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
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
