/**
 * The Bun entry the CLI spawns:
 *   bun apps/tui/src/main.tsx dashboard --socket <path> --home <dir> --version <v> [--cwd <dir>]
 *   bun apps/tui/src/main.tsx stream <runId> --socket <path> --home <dir>
 */
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
if (mode === 'dashboard') {
  const code = await runDashboard(client, {
    version: arg('version') ?? '0.0.0',
    home,
    cwd: arg('cwd'),
  });
  process.exit(code);
} else {
  const runId = process.argv[3];
  if (!runId) {
    console.error('usage: main.tsx stream <runId> ...');
    process.exit(2);
  }
  const r = await runStream(client, runId, { home, cwd: arg('cwd') });
  if (r.message) console.log(r.message);
  process.exit(r.code);
}
