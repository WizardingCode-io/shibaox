import { describe, expect, it } from 'vitest';
import { githubChannel, githubOrigin } from '../src/channels/github.js';
import type { RunReport } from '../src/runs/report.js';

function fakeExec() {
  const calls: { argv: string[]; env?: Record<string, string> }[] = [];
  const exec = async ({ argv, env }: { argv: string[]; env?: Record<string, string> }) => {
    calls.push({ argv, env });
    return {
      exitCode: 0,
      stdout: 'https://github.com/acme/app/issues/12#issuecomment-1',
      stderr: '',
      timedOut: false,
    };
  };
  return { exec, calls };
}
const report = (over: Partial<RunReport> = {}): RunReport => ({
  runId: 'r1',
  workflow: 'fix-issue',
  status: 'completed',
  origin: 'github:acme/app#12',
  project: '/p',
  spentUsd: 0.42,
  durationMs: 65_000,
  nodes: [
    { id: 'implement', status: 'completed', summary: 'wrote the fix' },
    {
      id: 'pr',
      status: 'completed',
      summary: 'pull request opened: https://github.com/acme/app/pull/40',
    },
  ],
  ...over,
});

describe('the github channel', () => {
  it('parses github:owner/repo#N origins and nothing else', () => {
    expect(githubOrigin('github:acme/app#12')).toEqual({ repo: 'acme/app', number: 12 });
    expect(githubOrigin('schedule:x')).toBeUndefined();
    expect(githubOrigin('github:acme/app')).toBeUndefined();
  });
  it('posts the report of a run that came from an issue as a comment on it, with the GitHub token of the vault', async () => {
    const { exec, calls } = fakeExec();
    const ch = githubChannel({ exec: exec as never, env: () => ({ GH_TOKEN: 'ghp_x' }) });
    await ch.report?.(report());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv.slice(0, 5)).toEqual(['gh', 'issue', 'comment', '12', '--repo']);
    expect(calls[0]?.argv).toContain('acme/app');
    const body = calls[0]?.argv[calls[0].argv.indexOf('--body') + 1] ?? '';
    expect(body).toContain('fix-issue');
    expect(body).toContain('done');
    expect(body).toContain('https://github.com/acme/app/pull/40');
    expect(body).toContain('$0.42');
    expect(body).toContain('shibaox');
    expect(calls[0]?.env).toMatchObject({ GH_TOKEN: 'ghp_x' });
  });
  it('says what the run waits for, and ignores runs from elsewhere and conversation replies', async () => {
    const { exec, calls } = fakeExec();
    const ch = githubChannel({ exec: exec as never, env: () => ({}) });
    await ch.report?.(report({ status: 'waiting_human', needs: 'Merge the pull request?' }));
    expect(calls[0]?.argv.join(' ')).toContain('Merge the pull request?');
    expect(calls[0]?.argv.join(' ')).toContain('shibaox approve');
    await ch.report?.(report({ origin: 'telegram:5' }));
    await ch.report?.(report({ origin: undefined }));
    expect(calls).toHaveLength(1);
    await ch.notify({
      id: 'human:r1:ship',
      kind: 'human',
      runId: 'r1',
      nodeId: 'ship',
      at: 't',
      prompt: 'Land it?',
      detail: {},
    });
    expect(calls).toHaveLength(1); // approvals are asked in the inbox and on Telegram, never on the issue
  });
});
