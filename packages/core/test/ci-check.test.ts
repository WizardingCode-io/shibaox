import { describe, expect, it } from 'vitest';
import { makeCiCheckRunner, type RunState } from '../src/index.js';

const base: RunState = {
  runId: 'r',
  workflow: 'w',
  input: { spec: 'Fix #12' },
  workspace: '/ws',
  branch: 'shibaox/r',
  status: 'running',
  nodes: {},
  spentUsd: 0,
  budgetWarned: false,
};
const ctx = (state: RunState) => ({
  runId: 'r',
  nodeId: 'g',
  workspace: '/ws',
  state,
  log: () => {},
});
const check = { name: 'ci', type: 'ci' as const, timeout_ms: 5000, interval_ms: 1 };

/** A `gh` that answers `pr checks` with the given pages, one per call. */
function fakeGh(pages: unknown[][]) {
  const calls: string[][] = [];
  let i = 0;
  const exec = async ({ argv }: { argv: string[] }) => {
    calls.push(argv);
    const page = pages[Math.min(i++, pages.length - 1)] ?? [];
    return { exitCode: 0, stdout: JSON.stringify(page), stderr: '', timedOut: false };
  };
  return { exec, calls };
}

describe('the ci check', () => {
  it('waits until no check is pending, then passes when every check passed, with links as evidence', async () => {
    const gh = fakeGh([
      [{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending', link: 'https://ci/1' }],
      [
        { name: 'build', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1' },
        { name: 'lint', state: 'SKIPPED', bucket: 'skipping', link: 'https://ci/2' },
      ],
    ]);
    const run = makeCiCheckRunner({ exec: gh.exec as never, sleep: async () => {} });
    const r = await run(
      check,
      ctx({
        ...base,
        nodes: {
          pr: {
            status: 'completed',
            attempts: 1,
            approvals: {},
            output: { number: 42, url: 'https://github.com/a/b/pull/42' },
          },
        },
      }),
    );
    expect(r).toMatchObject({ name: 'ci', type: 'ci', passed: true, skipped: false });
    expect(r.evidence).toContain('build');
    expect(r.evidence).toContain('https://ci/1');
    expect(gh.calls[0]).toEqual(expect.arrayContaining(['gh', 'pr', 'checks', '42']));
    expect(gh.calls).toHaveLength(2);
  });
  it('fails when a check failed, naming it; the PR number comes from the request when no pr node ran', async () => {
    const gh = fakeGh([[{ name: 'test', state: 'FAILURE', bucket: 'fail', link: 'https://ci/9' }]]);
    const run = makeCiCheckRunner({ exec: gh.exec as never, sleep: async () => {} });
    const r = await run(check, ctx({ ...base, input: { spec: 'Review #13 please' } }));
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('test');
    expect(r.suggestion).toMatch(/test/);
    expect(gh.calls[0]).toEqual(expect.arrayContaining(['13']));
  });
  it('uses the run branch when there is no number, passes with a note when there is no pull request at all, and times out on an endless pending', async () => {
    const none = {
      exec: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'no pull requests found for branch "shibaox/r"',
        timedOut: false,
      }),
    };
    const run = makeCiCheckRunner({ exec: none.exec as never, sleep: async () => {} });
    const r = await run(check, ctx({ ...base, input: {} }));
    expect(r).toMatchObject({ passed: true, skipped: true });
    expect(r.evidence).toMatch(/no pull request/i);
    const forever = fakeGh([[{ name: 'build', state: 'QUEUED', bucket: 'pending', link: '' }]]);
    let t = 0;
    const slow = makeCiCheckRunner({
      exec: forever.exec as never,
      sleep: async () => {},
      now: () => (t += 3000),
    });
    const r2 = await slow(check, ctx({ ...base, input: {} }));
    expect(r2.passed).toBe(false);
    expect(r2.evidence).toMatch(/still pending/i);
    expect(forever.calls[0]).toEqual(expect.arrayContaining(['shibaox/r']));
  });
});
