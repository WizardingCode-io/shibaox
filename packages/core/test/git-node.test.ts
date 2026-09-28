import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type GitContext, MergeQueue, runGitNode } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A project on `main` with one commit, and a run worktree on `shibaox/<runId>` with a change. */
function repo(o: { change?: boolean; origin?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gitnode-'));
  dirs.push(dir);
  const project = join(dir, 'proj');
  mkdirSync(project);
  writeFileSync(join(project, 'README.md'), '# proj\n');
  writeFileSync(
    join(project, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '--no-gpg-sign', '-m', 'init');
  if (o.origin) {
    const bare = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    git(project, 'remote', 'add', 'origin', bare);
    git(project, 'push', '-q', '-u', 'origin', 'main');
  }
  const worktree = join(project, '.shibaox', 'worktrees', 'r1');
  mkdirSync(join(project, '.shibaox', 'worktrees'), { recursive: true });
  writeFileSync(join(project, '.git', 'info', 'exclude'), '.shibaox/\n');
  git(project, 'worktree', 'add', '-q', worktree, '-b', 'shibaox/r1');
  if (o.change !== false) writeFileSync(join(worktree, 'feature.txt'), 'hello\n');
  return { dir, project, worktree };
}

const ctx = (r: ReturnType<typeof repo>, extra: Partial<GitContext> = {}): GitContext => ({
  runId: 'r1',
  workspace: r.worktree,
  project: r.project,
  branch: 'shibaox/r1',
  spec: 'Add the feature file\nwith a second line of detail',
  summaries: [{ nodeId: 'implement', summary: 'wrote feature.txt' }],
  log: () => {},
  ...extra,
});

/** A `gh` that records its argv and answers what the node needs. */
function fakeGh(dir: string): { bin: string; calls: () => string[][] } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'gh.log');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "pr view") exit 1 ;;
  "pr create") echo "https://github.com/acme/proj/pull/42" ;;
  "repo view") echo "main" ;;
esac
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    bin,
    calls: () =>
      (readFileSync(log, 'utf8').trim() ? readFileSync(log, 'utf8').trim().split('\n') : []).map(
        (l) => l.split(' '),
      ),
  };
}

describe('git node: commit', () => {
  it('commits the worktree changes with a message from the request and the node summaries', async () => {
    const r = repo();
    const out = await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    expect(out.output).toMatchObject({
      committed: true,
      sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(out.summary).toMatch(/^committed [0-9a-f]{7}/);
    const msg = git(r.worktree, 'log', '-1', '--format=%B');
    expect(msg.split('\n')[0]).toBe('Add the feature file');
    expect(msg).toContain('- implement: wrote feature.txt');
    expect(msg).toContain('Shibaox-Run: r1');
    expect(git(r.worktree, 'status', '--porcelain')).toBe('');
  });
  it('uses the message the node gives, or the one the describer writes', async () => {
    const r = repo();
    const describe = vi.fn(
      async () => 'feat: add feature.txt\n\nBecause the request asked for it.',
    );
    const out = await runGitNode(
      { type: 'git', action: 'commit', timeout_ms: 60_000 },
      ctx(r, { describe }),
    );
    expect(out.output).toMatchObject({ committed: true });
    expect(git(r.worktree, 'log', '-1', '--format=%s')).toBe('feat: add feature.txt');
    expect(describe.mock.calls[0]?.[0]).toMatchObject({ kind: 'commit', spec: expect.any(String) });
    expect(String(describe.mock.calls[0]?.[0].diff)).toContain('+hello');
    const r2 = repo();
    await runGitNode(
      { type: 'git', action: 'commit', message: 'chore: exact message', timeout_ms: 60_000 },
      ctx(r2, { describe }),
    );
    expect(git(r2.worktree, 'log', '-1', '--format=%s')).toBe('chore: exact message');
    const r3 = repo();
    await runGitNode(
      { type: 'git', action: 'commit', timeout_ms: 60_000 },
      ctx(r3, { describe: async () => `${'long title '.repeat(12)}\n\nbody` }),
    );
    expect(git(r3.worktree, 'log', '-1', '--format=%s').length).toBeLessThanOrEqual(72);
  });
  it('nothing to commit and not a repository are outcomes, not failures', async () => {
    const r = repo({ change: false });
    expect(
      (await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r))).output,
    ).toMatchObject({ committed: false, reason: 'nothing to commit' });
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    dirs.push(plain);
    expect(
      (
        await runGitNode(
          { type: 'git', action: 'commit', timeout_ms: 60_000 },
          ctx(r, { workspace: plain, project: plain, branch: undefined }),
        )
      ).output,
    ).toMatchObject({ committed: false, reason: 'not a git repository' });
  });
});

describe('git node: pr', () => {
  it('pushes the branch and opens a pull request through gh with a generated description', async () => {
    const r = repo({ origin: true });
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    const gh = fakeGh(r.dir);
    const out = await runGitNode(
      { type: 'git', action: 'pr', timeout_ms: 60_000 },
      ctx(r, { env: { PATH: `${gh.bin}:${process.env.PATH}` } }),
    );
    expect(out.output).toMatchObject({
      url: 'https://github.com/acme/proj/pull/42',
      number: 42,
      base: 'main',
      branch: 'shibaox/r1',
    });
    expect(out.summary).toContain('pull/42');
    // the branch is on origin
    expect(git(r.project, 'ls-remote', '--heads', 'origin', 'shibaox/r1')).toContain('shibaox/r1');
    const create = gh.calls().find((c) => c[0] === 'pr' && c[1] === 'create');
    expect(create).toBeDefined();
    expect(create?.join(' ')).toContain('--base main');
    expect(create?.join(' ')).toContain('--head shibaox/r1');
    expect(create?.join(' ')).toContain('--title');
  });
  it('outside a git repository pr and merge are outcomes, not failures', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    dirs.push(plain);
    const r = repo();
    const c = ctx(r, { workspace: plain, project: plain, branch: undefined });
    expect(
      (await runGitNode({ type: 'git', action: 'pr', timeout_ms: 60_000 }, c)).output,
    ).toMatchObject({
      opened: false,
      reason: 'not a git repository',
    });
    expect(
      (await runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, c)).output,
    ).toMatchObject({
      merged: false,
      reason: 'not a git repository',
    });
  });
  it('without a remote the pr action fails with a clear message', async () => {
    const r = repo();
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    await expect(
      runGitNode({ type: 'git', action: 'pr', timeout_ms: 60_000 }, ctx(r)),
    ).rejects.toThrow(/no remote "origin"/);
  });
});

describe('git node: merge', () => {
  it('rebases on the base, runs the tests and lands the branch on main (and origin when there is one)', async () => {
    const r = repo({ origin: true });
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    // main moved meanwhile, without conflict
    writeFileSync(join(r.project, 'other.txt'), 'x\n');
    git(r.project, 'add', '-A');
    git(r.project, 'commit', '-q', '--no-gpg-sign', '-m', 'other');
    git(r.project, 'push', '-q', 'origin', 'main');
    const out = await runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(r));
    expect(out.output).toMatchObject({ merged: true, base: 'main', tests: 'npm test' });
    expect(git(r.project, 'log', '--format=%s', 'main')).toMatch(
      /^Add the feature file\nother\ninit$/,
    );
    expect(git(r.project, 'rev-parse', 'main')).toBe(git(r.project, 'rev-parse', 'origin/main'));
    expect(git(r.project, 'status', '--porcelain')).toBe('');
  });
  it('failing tests or a rebase conflict stop the merge and leave main untouched', async () => {
    const r = repo();
    writeFileSync(
      join(r.worktree, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(1)"' } }),
    );
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    // the base moved: the rebased tree is tested again, and fails
    writeFileSync(join(r.project, 'other.txt'), 'x\n');
    git(r.project, 'add', '-A');
    git(r.project, 'commit', '-q', '--no-gpg-sign', '-m', 'other');
    const before = git(r.project, 'rev-parse', 'main');
    await expect(
      runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(r)),
    ).rejects.toThrow(/tests failed/);
    expect(git(r.project, 'rev-parse', 'main')).toBe(before);
    // a conflict on the base
    const c = repo();
    writeFileSync(join(c.worktree, 'README.md'), '# theirs\n');
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(c));
    writeFileSync(join(c.project, 'README.md'), '# ours\n');
    git(c.project, 'commit', '-q', '--no-gpg-sign', '-am', 'ours');
    await expect(
      runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(c)),
    ).rejects.toThrow(/rebase/);
    expect(git(c.worktree, 'status', '--porcelain')).toBe(''); // the rebase was aborted
  });
  it('a cancelled run never lands: the merge checks the signal before landing and pushing', async () => {
    const r = repo({ origin: true });
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    const before = git(r.project, 'rev-parse', 'main');
    const aborted = new AbortController();
    aborted.abort(new Error('cancelled by the user'));
    await expect(
      runGitNode(
        { type: 'git', action: 'merge', timeout_ms: 60_000 },
        ctx(r, { signal: aborted.signal }),
      ),
    ).rejects.toThrow(/cancelled/);
    expect(git(r.project, 'rev-parse', 'main')).toBe(before);
    expect(git(r.project, 'rev-parse', 'origin/main')).toBe(before);
  });
  it('lands on origin first when there is one: a stale local base never blocks, unpushed local work is never pushed', async () => {
    const r = repo({ origin: true });
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    // origin moved (a teammate pushed) while the local main stayed behind
    const clone = join(r.dir, 'clone');
    git(r.dir, 'clone', '-q', join(r.dir, 'origin.git'), clone);
    writeFileSync(join(clone, 'teammate.txt'), 't\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '--no-gpg-sign', '-m', 'teammate');
    git(clone, 'push', '-q', 'origin', 'main');
    const out = await runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(r));
    expect(out.output).toMatchObject({ merged: true, pushed: true, localUpdated: true });
    expect(git(r.project, 'log', '--format=%s', 'origin/main')).toBe(
      'Add the feature file\nteammate\ninit',
    );
    expect(git(r.project, 'rev-parse', 'main')).toBe(git(r.project, 'rev-parse', 'origin/main'));
    // now the local main has an unpushed commit of the user's own
    writeFileSync(join(r.project, 'mine.txt'), 'm\n');
    git(r.project, 'add', '-A');
    git(r.project, 'commit', '-q', '--no-gpg-sign', '-m', 'mine (unpushed)');
    const w2 = join(r.project, '.shibaox', 'worktrees', 'r2');
    git(r.project, 'worktree', 'add', '-q', w2, '-b', 'shibaox/r2', 'origin/main');
    writeFileSync(join(w2, 'second.txt'), 'y\n');
    await runGitNode(
      { type: 'git', action: 'commit', timeout_ms: 60_000 },
      ctx(r, { runId: 'r2', workspace: w2, branch: 'shibaox/r2', spec: 'Second change' }),
    );
    const out2 = await runGitNode(
      { type: 'git', action: 'merge', timeout_ms: 60_000 },
      ctx(r, { runId: 'r2', workspace: w2, branch: 'shibaox/r2', spec: 'Second change' }),
    );
    expect(out2.output).toMatchObject({ merged: true, pushed: true, localUpdated: false });
    expect(git(r.project, 'log', '--format=%s', 'origin/main')).not.toContain('mine (unpushed)');
    expect(git(r.project, 'log', '--format=%s', 'origin/main')).toContain('Second change');
    expect(git(r.project, 'log', '-1', '--format=%s', 'main')).toBe('mine (unpushed)'); // untouched
    expect(out2.summary).toMatch(/local main.*pull/);
  });
  it('the base is the branch the run forked from, else the remote default, before main', async () => {
    const r = repo();
    git(r.project, 'branch', 'develop', 'main');
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    const out = await runGitNode(
      { type: 'git', action: 'merge', timeout_ms: 60_000 },
      ctx(r, { base: 'develop' }),
    );
    expect(out.output).toMatchObject({ merged: true, base: 'develop' });
    expect(git(r.project, 'log', '-1', '--format=%s', 'develop')).toBe('Add the feature file');
    expect(git(r.project, 'log', '-1', '--format=%s', 'main')).toBe('init');
  });
  it('merge and pr need a worktree run; an in-place commit stays within the workspace', async () => {
    const r = repo();
    await expect(
      runGitNode(
        { type: 'git', action: 'merge', timeout_ms: 60_000 },
        ctx(r, { branch: undefined }),
      ),
    ).rejects.toThrow(/worktree/);
    await expect(
      runGitNode({ type: 'git', action: 'pr', timeout_ms: 60_000 }, ctx(r, { branch: undefined })),
    ).rejects.toThrow(/worktree/);
  });
  it('nothing to land and a dirty workspace are reported for what they are', async () => {
    const r = repo({ change: false });
    expect(
      (await runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(r))).output,
    ).toMatchObject({ merged: false, reason: 'nothing to land' });
    const d = repo();
    await expect(
      runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(d)),
    ).rejects.toThrow(/uncommitted changes/);
  });
  it('merges go through the queue one project at a time, in order', async () => {
    const r = repo();
    await runGitNode({ type: 'git', action: 'commit', timeout_ms: 60_000 }, ctx(r));
    // a second run branch off the same main
    const w2 = join(r.project, '.shibaox', 'worktrees', 'r2');
    git(r.project, 'worktree', 'add', '-q', w2, '-b', 'shibaox/r2', 'main');
    writeFileSync(join(w2, 'second.txt'), 'y\n');
    await runGitNode(
      { type: 'git', action: 'commit', timeout_ms: 60_000 },
      ctx(r, { runId: 'r2', workspace: w2, branch: 'shibaox/r2', spec: 'Second change' }),
    );
    const queue = new MergeQueue();
    const order: string[] = [];
    const log = (l: string) => order.push(l);
    const [a, b] = await Promise.all([
      runGitNode({ type: 'git', action: 'merge', timeout_ms: 60_000 }, ctx(r, { queue, log })),
      runGitNode(
        { type: 'git', action: 'merge', timeout_ms: 60_000 },
        ctx(r, { runId: 'r2', workspace: w2, branch: 'shibaox/r2', queue, log }),
      ),
    ]);
    expect(a.output).toMatchObject({ merged: true, tests: null }); // the base did not move: the gate already tested this tree
    expect(b.output).toMatchObject({ merged: true, tests: 'npm test' }); // rebased on the first: tested again
    expect(git(r.project, 'log', '--format=%s', 'main')).toBe(
      'Second change\nAdd the feature file\ninit',
    );
    expect(order.some((l) => /queue/.test(l))).toBe(true);
  });
});
