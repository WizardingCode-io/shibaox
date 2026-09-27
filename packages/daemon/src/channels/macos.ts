import { runArgv } from '@shibaox/core';
import type { InboxItem } from '../inbox.js';
import { type RunReport, STATUS_SYMBOL } from '../runs/report.js';
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

export function macosReportText(r: RunReport): { title: string; body: string } {
  const symbol = STATUS_SYMBOL[r.status] ?? '•';
  const title = `${symbol} ${r.workflow} ${r.status === 'completed' ? 'done' : r.status.replace('_', ' ')}`;
  const body =
    r.reply ??
    r.needs ??
    r.error ??
    `${r.nodes.length} nodes · $${r.spentUsd.toFixed(2)} (run ${r.runId.slice(0, 8)})`;
  return { title, body: body.slice(0, 200) };
}

/** Native macOS notifications; no answer path (the CLI or Telegram answers). */
export function macosChannel(o: MacosOptions = {}): Channel {
  const exec = o.exec ?? runArgv;
  let notifier = o.hasTerminalNotifier;
  const show = async (title: string, body: string) => {
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
  };
  return {
    id: 'macos',
    async notify(item) {
      const { title, body } = macosText(item);
      await show(title, body);
    },
    async report(r) {
      const { title, body } = macosReportText(r);
      await show(title, body);
    },
  };
}
