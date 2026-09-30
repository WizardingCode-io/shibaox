/**
 * The Bun entry the CLI spawns (from the apps/tui root, with @opentui/solid/preload):
 *   bun --preload @opentui/solid/preload src/main.tsx dashboard --socket <path> | --remote <url> --home <dir> --version <v> [--cwd <dir>]
 *   bun --preload @opentui/solid/preload src/main.tsx stream <runId> --socket <path> --home <dir>
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DaemonClient } from '@wizardingcode/shibaox-daemon/client';
import { runDashboard, runStream } from './app.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const mode = process.argv[2];
const socket = arg('socket');
const remote = arg('remote');
const home = arg('home');
if ((!socket && !remote) || !home || (mode !== 'dashboard' && mode !== 'stream')) {
  console.error(
    'usage: main.tsx dashboard|stream [runId] --socket <path> | --remote <url> --home <dir> [--version <v>] [--cwd <dir>]',
  );
  process.exit(2);
}
// the token for a remote daemon comes in the environment (never on the command line) and
// goes no further than this client
const token = process.env.SHIBAOX_REMOTE_TOKEN;
delete process.env.SHIBAOX_REMOTE_TOKEN;
const client = remote
  ? new DaemonClient({ baseUrl: remote, token })
  : new DaemonClient(socket as string);
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
    remote,
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
    remote,
    log,
  });
  if (r.message) console.log(r.message);
  process.exit(r.code);
}
