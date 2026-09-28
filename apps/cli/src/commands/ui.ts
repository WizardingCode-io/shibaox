import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from '@wizardingcode/shibaox-core';
import { homePaths } from '@wizardingcode/shibaox-daemon';
import { connect } from '../client.js';
import { CLI_VERSION } from '../version.js';

export const NO_TTY_MESSAGE = 'The dashboard needs an interactive terminal. Try: shibaox runs';
export const NO_BUN_MESSAGE =
  'The dashboard needs Bun 1.3 or later (https://bun.sh). Install it, or use: shibaox runs / inbox / follow --json';
export const NO_TUI_MESSAGE =
  'The dashboard files are missing (apps/tui). Reinstall shibaox, or use: shibaox runs';

/**
 * The terminal UI package root: the sibling package in the monorepo layout, else the
 * `@wizardingcode/shibaox-tui` package an npm install placed next to us (Bun runs its source).
 */
export function resolveTuiRoot(fromUrl: string = import.meta.url): string {
  const sibling = fileURLToPath(new URL('../../../tui/', fromUrl));
  if (existsSync(join(sibling, 'src', 'main.tsx'))) return sibling;
  const require = createRequire(fromUrl);
  try {
    return dirname(require.resolve('@wizardingcode/shibaox-tui/package.json'));
  } catch {
    // an exports map without ./package.json: resolve the main export and walk up to the package
  }
  try {
    let dir = dirname(require.resolve('@wizardingcode/shibaox-tui'));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'main.tsx')))
        return dir;
      dir = dirname(dir);
    }
  } catch {
    // not installed as a package either
  }
  return sibling;
}
export const TUI_ROOT = resolveTuiRoot();
export const TUI_ENTRY = join(TUI_ROOT, 'src/main.tsx');
/** Bun flags before the entry: the Solid JSX transform for the OpenTUI app. */
export const TUI_ARGS = ['--preload', '@opentui/solid/preload'] as const;
export const MIN_BUN = [1, 3] as const;

/** Bun 1.3 or later on the PATH. */
export async function bunAvailable(): Promise<boolean> {
  const r = await runCommand({ command: 'bun --version', cwd: process.cwd(), timeoutMs: 10_000 });
  if (r.exitCode !== 0) return false;
  const [major = 0, minor = 0] = r.stdout.trim().split('.').map(Number);
  return major > MIN_BUN[0] || (major === MIN_BUN[0] && minor >= MIN_BUN[1]);
}

const ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TERM',
  'TERM_PROGRAM',
  'COLORTERM',
  'LANG',
  'NO_COLOR',
  'FORCE_COLOR',
  'BUN_INSTALL',
];
const ENV_PREFIXES = ['LC_', 'SHIBAOX_'];

/**
 * How the TUI is spawned: from its own package root (never the user's project, whose bunfig.toml
 * preloads and .env would run inside it; ours carries the Solid preload) and with only the env
 * the terminal UI needs (no provider keys: it talks to the daemon over the socket).
 */
export function tuiSpawnOptions(env: NodeJS.ProcessEnv = process.env): {
  cwd: string;
  env: Record<string, string>;
} {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    if (v !== undefined && (ENV_KEYS.includes(k) || ENV_PREFIXES.some((p) => k.startsWith(p))))
      out[k] = v;
  return { cwd: TUI_ROOT, env: out };
}

/** Sequences that put a terminal back after a full-screen app died without cleaning up. */
export const TERMINAL_RESTORE =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l';

/**
 * Runs the OpenTUI app under Bun with the terminal attached; resolves with its exit code. A
 * crash restores the terminal and says so; a signal to the CLI is forwarded to Bun.
 */
export function spawnTui(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [...TUI_ARGS, TUI_ENTRY, ...args], {
      stdio: 'inherit',
      ...tuiSpawnOptions(),
    });
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const onTerm = forward('SIGTERM');
    const onHup = forward('SIGHUP');
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const cleanup = () => {
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (code === 0) return resolve(0);
      process.stdout.write(TERMINAL_RESTORE);
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        // not a tty
      }
      console.error(`The dashboard stopped (${signal ? `signal ${signal}` : `exit ${code}`}).`);
      resolve(code ?? 1);
    });
  });
}

/** `shibaox` / `shibaox ui`: the interactive dashboard over the daemon. */
export async function uiCommand(): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(NO_TTY_MESSAGE);
    return 1;
  }
  if (!existsSync(TUI_ENTRY)) {
    console.error(NO_TUI_MESSAGE);
    return 1;
  }
  if (!(await bunAvailable())) {
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
