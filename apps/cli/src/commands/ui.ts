import { renderDashboard } from '@shibaox/tui';
import { connect } from '../client.js';
import { CLI_VERSION } from '../version.js';

export const NO_TTY_MESSAGE = 'The dashboard needs an interactive terminal. Try: shibaox runs';

/** `shibaox` / `shibaox ui`: the interactive dashboard over the daemon. */
export async function uiCommand(): Promise<number> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(NO_TTY_MESSAGE);
    return 1;
  }
  const client = await connect({ write: true });
  return renderDashboard(client, { version: CLI_VERSION, env: process.env, cwd: process.cwd() });
}
