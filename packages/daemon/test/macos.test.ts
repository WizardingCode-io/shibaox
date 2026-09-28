import type { runArgv } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { macosChannel } from '../src/channels/macos.js';
import type { InboxItem } from '../src/inbox.js';

const item: InboxItem = {
  id: 'approval:a1',
  kind: 'approval',
  runId: 'run-12345678',
  nodeId: 'implement',
  at: 'x',
  prompt: 'git push "origin" main',
  detail: {},
};

function fakeExec(exitCode = 0) {
  const calls: string[][] = [];
  const exec: typeof runArgv = async ({ argv }) => {
    calls.push(argv);
    return { exitCode, stdout: '', stderr: 'boom', timedOut: false };
  };
  return { exec, calls };
}

describe('macos channel', () => {
  it('uses osascript with quoted text when terminal-notifier is absent', async () => {
    const { exec, calls } = fakeExec();
    await macosChannel({ exec, hasTerminalNotifier: false }).notify(item);
    expect(calls[0]?.[0]).toBe('osascript');
    expect(calls[0]?.[2]).toBe(
      'display notification "git push \\"origin\\" main (run run-1234, node implement)" with title "Shibaox" subtitle "Approval needed"',
    );
  });
  it('prefers terminal-notifier and reports failures', async () => {
    const { exec, calls } = fakeExec(1);
    await expect(macosChannel({ exec, hasTerminalNotifier: true }).notify(item)).rejects.toThrow(
      'terminal-notifier failed: boom',
    );
    expect(calls[0]?.slice(0, 5)).toEqual([
      'terminal-notifier',
      '-title',
      'Shibaox',
      '-subtitle',
      'Approval needed',
    ]);
  });
});
