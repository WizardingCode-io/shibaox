import { existsSync } from 'node:fs';
import type { GitNodeSchema } from '@shibaox/schemas';
import type { z } from 'zod';
import { detectTestCommand } from '../gates/detect.js';
import { defaultMergeQueue, type MergeQueue } from '../run/merge-queue.js';
import { runArgv, runCommand } from './code.js';

export type GitNode = z.infer<typeof GitNodeSchema>;

/** What a describer is asked for: a commit message or a pull request body. */
export interface DescribeRequest {
  kind: 'commit' | 'pr';
  spec: string;
  summaries: { nodeId: string; summary: string }[];
  diff: string;
}

export interface GitContext {
  runId: string;
  /** Where the run's files are (a worktree, or the project itself in place). */
  workspace: string;
  /** The project's main checkout (where the base branch lives). */
  project: string;
  /** The run branch of a worktree run; absent in place (the checkout's own branch is used). */
  branch?: string;
  /** The request (`input.spec`), the first line of which titles commits and PRs. */
  spec: string;
  /** What the run's nodes did so far. */
  summaries: { nodeId: string; summary: string }[];
  /** Writes a commit message / PR body from the change; absent or failing → deterministic text. */
  describe?: (r: DescribeRequest) => Promise<string>;
  queue?: MergeQueue;
  env?: Record<string, string>;
  log: (line: string) => void;
}

export interface GitOutcome {
  output: Record<string, unknown>;
  summary: string;
}

const MAX_DIFF = 60_000;
const TITLE_MAX = 72;

async function git(
  cwd: string,
  args: string[],
  o: { env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<string> {
  const r = await runArgv({
    argv: ['git', ...args],
    cwd,
    timeoutMs: o.timeoutMs ?? 120_000,
    env: o.env,
  });
  if (r.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} failed: ${(r.stderr.trim() || r.stdout.trim()).slice(-800)}`,
    );
  return r.stdout.trim();
}

async function tryGit(
  cwd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string | undefined> {
  const r = await runArgv({ argv: ['git', ...args], cwd, timeoutMs: 60_000, env });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

const isRepo = async (dir: string) =>
  existsSync(dir) && (await tryGit(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';

/** `Add the feature file` from the request's first line, cut to a commit title. */
export function titleOf(spec: string): string {
  const line =
    spec
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? 'shibaox change';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/** The deterministic message: title, the request, what each node did, and the run trailer. */
export function defaultMessage(ctx: GitContext): string {
  const title = titleOf(ctx.spec);
  const rest = ctx.spec.split('\n').slice(1).join('\n').trim();
  const body = [
    ...(rest ? [rest] : []),
    ...(ctx.summaries.length > 0
      ? [ctx.summaries.map((s) => `- ${s.nodeId}: ${s.summary.slice(0, 200)}`).join('\n')]
      : []),
  ].join('\n\n');
  return `${title}${body ? `\n\n${body}` : ''}`;
}

const withTrailer = (message: string, runId: string) =>
  `${message.trim()}\n\nShibaox-Run: ${runId}\n`;

async function describeOr(
  ctx: GitContext,
  kind: 'commit' | 'pr',
  diff: string,
  fallback: string,
): Promise<string> {
  if (!ctx.describe) return fallback;
  try {
    const text = (
      await ctx.describe({ kind, spec: ctx.spec, summaries: ctx.summaries, diff })
    ).trim();
    return text || fallback;
  } catch (e) {
    ctx.log(
      `describe (${kind}) failed, using the default text: ${e instanceof Error ? e.message : String(e)}`,
    );
    return fallback;
  }
}

async function commit(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  if (!(await isRepo(ctx.workspace)))
    return {
      output: { committed: false, reason: 'not a git repository' },
      summary: 'nothing to commit: not a git repository',
    };
  await git(ctx.workspace, ['add', '-A'], { env: ctx.env });
  const staged = await runArgv({
    argv: ['git', 'diff', '--cached', '--quiet'],
    cwd: ctx.workspace,
    timeoutMs: 60_000,
    env: ctx.env,
  });
  if (staged.exitCode === 0)
    return {
      output: { committed: false, reason: 'nothing to commit' },
      summary: 'nothing to commit',
    };
  const diff = (await git(ctx.workspace, ['diff', '--cached'], { env: ctx.env })).slice(
    0,
    MAX_DIFF,
  );
  const message = node.message ?? (await describeOr(ctx, 'commit', diff, defaultMessage(ctx)));
  await git(ctx.workspace, ['commit', '-q', '--no-verify', '-m', withTrailer(message, ctx.runId)], {
    env: ctx.env,
    timeoutMs: node.timeout_ms,
  });
  const sha = await git(ctx.workspace, ['rev-parse', 'HEAD'], { env: ctx.env });
  return {
    output: { committed: true, sha, message },
    summary: `committed ${sha.slice(0, 7)}: ${message.split('\n')[0]}`,
  };
}

async function currentBranch(ctx: GitContext): Promise<string> {
  if (ctx.branch) return ctx.branch;
  const b = await git(ctx.workspace, ['rev-parse', '--abbrev-ref', 'HEAD'], { env: ctx.env });
  if (b === 'HEAD') throw new Error('the workspace is on a detached HEAD: nothing to push');
  return b;
}

async function hasOrigin(ctx: GitContext): Promise<boolean> {
  return (await tryGit(ctx.workspace, ['remote', 'get-url', 'origin'], ctx.env)) !== undefined;
}

async function baseBranch(node: GitNode, ctx: GitContext, gh: boolean): Promise<string> {
  if (node.base) return node.base;
  if (gh) {
    const r = await runArgv({
      argv: ['gh', 'repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
      cwd: ctx.workspace,
      timeoutMs: 30_000,
      env: ctx.env,
    });
    if (r.exitCode === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  const head = await tryGit(
    ctx.project,
    ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ctx.env,
  );
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master'])
    if (
      (await tryGit(
        ctx.project,
        ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`],
        ctx.env,
      )) !== undefined
    )
      return b;
  throw new Error('no base branch: set `base` on the git node');
}

async function pr(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  if (!(await isRepo(ctx.workspace)))
    return {
      output: { opened: false, reason: 'not a git repository' },
      summary: 'no pull request: not a git repository',
    };
  if (!(await hasOrigin(ctx)))
    throw new Error('no remote "origin": a pull request needs one (or use action: merge)');
  const branch = await currentBranch(ctx);
  const base = await baseBranch(node, ctx, true);
  await git(ctx.workspace, ['push', '-q', '-u', 'origin', branch], {
    env: ctx.env,
    timeoutMs: node.timeout_ms,
  });
  // an open PR for the branch is reused
  const existing = await runArgv({
    argv: [
      'gh',
      'pr',
      'view',
      branch,
      '--json',
      'url,number',
      '-q',
      '.url + " " + (.number|tostring)',
    ],
    cwd: ctx.workspace,
    timeoutMs: 30_000,
    env: ctx.env,
  });
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    const [url, number] = existing.stdout.trim().split(' ');
    return {
      output: { url, number: Number(number), base, branch, reused: true },
      summary: `pull request already open: ${url}`,
    };
  }
  const diff =
    (await tryGit(ctx.workspace, ['diff', `${base}...HEAD`], ctx.env))?.slice(0, MAX_DIFF) ?? '';
  const title = titleOf(ctx.spec);
  const body =
    node.message ??
    (await describeOr(
      ctx,
      'pr',
      diff,
      `${defaultMessage(ctx)}\n\nOpened by shibaox (run ${ctx.runId}).`,
    ));
  const r = await runArgv({
    argv: [
      'gh',
      'pr',
      'create',
      '--base',
      base,
      '--head',
      branch,
      '--title',
      title,
      '--body',
      body,
    ],
    cwd: ctx.workspace,
    timeoutMs: node.timeout_ms,
    env: ctx.env,
  });
  if (r.exitCode !== 0)
    throw new Error(`gh pr create failed: ${(r.stderr.trim() || r.stdout.trim()).slice(-800)}`);
  const url =
    r.stdout
      .trim()
      .split('\n')
      .find((l) => /^https?:\/\//.test(l)) ?? r.stdout.trim();
  const number = Number(/\/(\d+)\s*$/.exec(url)?.[1] ?? Number.NaN);
  return {
    output: { url, ...(Number.isFinite(number) ? { number } : {}), base, branch, title },
    summary: `pull request opened: ${url}`,
  };
}

async function merge(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  // queued before anything async: the order is the order the runs asked to land
  const queue = ctx.queue ?? defaultMergeQueue;
  const ahead = queue.ahead(ctx.project);
  if (ahead > 0) ctx.log(`merge queue: ${ahead} ahead for ${ctx.project}`);
  return queue.enqueue(ctx.project, async () => {
    if (!(await isRepo(ctx.workspace)))
      return {
        output: { merged: false, reason: 'not a git repository' },
        summary: 'nothing to merge: not a git repository',
      };
    const branch = await currentBranch(ctx);
    ctx.log(`merge queue: landing ${branch}`);
    const origin = await hasOrigin(ctx);
    const base = await baseBranch(node, ctx, false);
    if (branch === base) throw new Error(`the workspace is on "${base}" itself: nothing to merge`);
    if (origin) {
      await git(ctx.project, ['fetch', '-q', 'origin', base], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
      // a base checkout that is behind origin moves up first (fast-forward only)
      await tryGit(
        ctx.project,
        ['fetch', '-q', '.', `refs/remotes/origin/${base}:refs/heads/${base}`],
        ctx.env,
      );
    }
    // rebase the run branch on the base; a conflict aborts and fails the node
    const rebase = await runArgv({
      argv: ['git', 'rebase', '-q', base],
      cwd: ctx.workspace,
      timeoutMs: node.timeout_ms,
      env: ctx.env,
    });
    if (rebase.exitCode !== 0) {
      await tryGit(ctx.workspace, ['rebase', '--abort'], ctx.env);
      throw new Error(
        `rebase on ${base} failed (conflicts): ${(rebase.stderr.trim() || rebase.stdout.trim()).slice(-800)}`,
      );
    }
    const tests = node.tests ?? detectTestCommand(ctx.workspace);
    if (tests) {
      ctx.log(`merge queue: running ${tests}`);
      const t = await runCommand({
        command: tests,
        cwd: ctx.workspace,
        timeoutMs: node.timeout_ms,
        env: ctx.env,
      });
      if (t.exitCode !== 0 || t.timedOut)
        throw new Error(
          `tests failed before merge (${tests}, exit ${t.exitCode}${t.timedOut ? ', timed out' : ''}): ${(t.stderr || t.stdout).slice(-800)}`,
        );
    }
    // land: the checkout of the base merges fast-forward; another checkout gets its ref moved
    const onBase =
      (await tryGit(ctx.project, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.env)) === base;
    if (onBase) {
      const dirty = await git(ctx.project, ['status', '--porcelain', '--untracked-files=no'], {
        env: ctx.env,
      });
      if (dirty)
        throw new Error(
          `the checkout of "${base}" has uncommitted changes: commit or stash them before merging`,
        );
      await git(ctx.project, ['merge', '-q', '--ff-only', branch], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
    } else {
      await git(ctx.project, ['fetch', '-q', '.', `${branch}:${base}`], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
    }
    const sha = await git(ctx.project, ['rev-parse', base], { env: ctx.env });
    if (origin)
      await git(ctx.project, ['push', '-q', 'origin', base], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
    return {
      output: { merged: true, base, sha, branch, tests: tests ?? null, pushed: origin },
      summary: `merged ${branch} into ${base} (${sha.slice(0, 7)})${tests ? `, tests: ${tests}` : ''}${origin ? ', pushed' : ''}`,
    };
  });
}

/** Runs one `git` node; throws on failure like a `code` node. */
export async function runGitNode(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  switch (node.action) {
    case 'commit':
      return commit(node, ctx);
    case 'pr':
      return pr(node, ctx);
    case 'merge':
      return merge(node, ctx);
  }
}
