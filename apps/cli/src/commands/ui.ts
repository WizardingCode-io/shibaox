import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runCommand } from '@shibaox/core';
import { homePaths } from '@shibaox/daemon';
import { connect } from '../client.js';
import { CLI_VERSION } from '../version.js';

export const NO_TTY_MESSAGE = 'The dashboard needs an interactive terminal. Try: shibaox runs';
export const NO_BUN_MESSAGE =
  'The dashboard needs Bun (https://bun.sh). Install it, or use: shibaox runs / inbox / follow --json';

/** The Bun entry of the terminal UI (a sibling package in the monorepo layout). */
export const TUI_ENTRY = fileURLToPath(new URL('../../../tui/src/main.tsx', import.meta.url));

export async function bunAvailable(): Promise<boolean> {
  const r = await runCommand({ command: 'bun --version', cwd: process.cwd(), timeoutMs: 10_000 });
  return r.exitCode === 0;
}

/** Runs the OpenTUI app under Bun with the terminal attached; resolves with its exit code. */
export function spawnTui(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [TUI_ENTRY, ...args], { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** `shibaox` / `shibaox ui`: the interactive dashboard over the daemon. */
export async function uiCommand(): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(NO_TTY_MESSAGE);
    return 1;
  }
  if (!(await bunAvailable()) || !existsSync(TUI_ENTRY)) {
    console.error(NO_BUN_MESSAGE);
    return 1;
  }
  await connect({ write: true }); // starts the daemon when needed, checks versions
  const paths = homePaths();
  return spawnTui([
    'dashboard',
    '--socket',
    paths.socket,
    '--home',
    paths.root,
    '--version',
    CLI_VERSION,
    '--cwd',
    process.cwd(),
  ]);
}
