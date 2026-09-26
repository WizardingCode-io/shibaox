import { runArgv } from '@shibaox/core';
import type { InboxItem } from '../inbox.js';
import type { Channel } from './types.js';

export interface MacosOptions {
  exec?: typeof runArgv;
  /** Whether `terminal-notifier` is on the PATH (probed once by default). */
  hasTerminalNotifier?: boolean;
}

const quote = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 200);

export function macosText(item: InboxItem): { title: string; body: string } {
  const title = item.kind === 'approval' ? 'Approval needed' : 'Decision needed';
  const body = `${item.prompt} (run ${item.runId.slice(0, 8)}, node ${item.nodeId})`;
  return { title, body };
}

/** Native macOS notifications; no answer path (the CLI or Telegram answers). */
export function macosChannel(o: MacosOptions = {}): Channel {
  const exec = o.exec ?? runArgv;
  let notifier = o.hasTerminalNotifier;
  return {
    id: 'macos',
    async notify(item) {
      const { title, body } = macosText(item);
      if (notifier === undefined) {
        const r = await exec({ argv: ['which', 'terminal-notifier'], cwd: '/', timeoutMs: 5_000 });
        notifier = r.exitCode === 0;
      }
      const argv = notifier
        ? [
            'terminal-notifier',
            '-title',
            'Shibaox',
            '-subtitle',
            title,
            '-message',
            body,
            '-activate',
            'com.apple.Terminal',
          ]
        : [
            'osascript',
            '-e',
            `display notification "${quote(body)}" with title "Shibaox" subtitle "${quote(title)}"`,
          ];
      const r = await exec({ argv, cwd: '/', timeoutMs: 10_000 });
      if (r.exitCode !== 0) throw new Error(`${argv[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
    },
  };
}
