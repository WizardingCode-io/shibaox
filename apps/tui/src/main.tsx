/**
 * The Bun entry the CLI spawns (from the apps/tui root, with @opentui/solid/preload):
 *   bun --preload @opentui/solid/preload src/main.tsx dashboard --socket <path> --home <dir> --version <v> [--cwd <dir>]
 *   bun --preload @opentui/solid/preload src/main.tsx stream <runId> --socket <path> --home <dir>
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '@shibaox/daemon/client';
import { runDashboard, runStream } from './app.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];
const socket = arg('socket');
const home = arg('home');
if (!socket || !home || (mode !== 'dashboard' && mode !== 'stream')) {
  console.error(
    'usage: main.tsx dashboard|stream [runId] --socket <path> --home <dir> [--version <v>] [--cwd <dir>]',
  );
  process.exit(2);
}
const client = new DaemonClient(socket);
const log = (line: string) => {
  try {
    appendFileSync(join(home, 'tui.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // the log is a convenience; never fail the UI over it
  }
};
if (mode === 'dashboard') {
  const code = await runDashboard(client, {
    version: arg('version') ?? '0.0.0',
    home,
    cwd: arg('cwd'),
    log,
  });
  process.exit(code);
} else {
  const runId = process.argv[3];
  if (!runId) {
    console.error('usage: main.tsx stream <runId> ...');
    process.exit(2);
  }
  const r = await runStream(client, runId, {
    version: arg('version') ?? '0.0.0',
    home,
    cwd: arg('cwd'),
    log,
  });
  if (r.message) console.log(r.message);
  process.exit(r.code);
}
