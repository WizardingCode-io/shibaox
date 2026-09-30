import { existsSync } from 'node:fs';
import type { GitNodeSchema } from '@wizardingcode/shibaox-schemas';
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
  /** The run branch of a worktree run; absent in place (`merge` and `pr` then refuse). */
  branch?: string;
  /** The branch the project was on when the run started: the default base to land on. */
  base?: string;
  /** The run's cancellation: checked before anything lands or is pushed. */
  signal?: AbortSignal;
  /** The request (`input.spec`), the first line of which titles commits and PRs. */
  spec: string;
  /** What the run's nodes did so far. */
  summaries: { nodeId: string; summary: string }[];
  /** Writes a commit message / PR body from the change; absent or failing → deterministic text. */
  describe?: (r: DescribeRequest) => Promise<string>;
  queue?: MergeQueue;
  env?: Record<string, string>;
  /** The pull request the run works on (a `pr` node, or the request): `review`, `comment`, `merge_pr` need it. */
  pr?: { number: number; url?: string };
  /** What each node wrote (`output.text`, else its summary): what `review` and `comment` publish. */
  texts?: Record<string, string>;
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

/** The deterministic message: title, the request, what each node did. */
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

/** Aborts a step once the run was cancelled. */
function checkCancelled(ctx: GitContext): void {
  if (ctx.signal?.aborted) {
    const reason = ctx.signal.reason;
    throw new Error(
      `cancelled: ${reason instanceof Error ? reason.message : String(reason ?? 'run cancelled')}`,
    );
  }
}

async function describeOr(
  ctx: GitContext,
  kind: 'commit' | 'pr',
  diff: string,
  fallback: string,
): Promise<string> {
  if (!ctx.describe) return fallback;
  try {
    let text = (
      await ctx.describe({ kind, spec: ctx.spec, summaries: ctx.summaries, diff })
    ).trim();
    if (kind === 'commit' && text) {
      // the model's first line is the commit title: git log and forges show 72 characters
      const [first = '', ...rest] = text.split('\n');
      text = [titleOf(first), ...rest].join('\n');
    }
    return text || fallback;
  } catch (e) {
    ctx.log(
      `describe (${kind}) failed, using the default text: ${e instanceof Error ? e.message : String(e)}`,
    );
    return fallback;
  }
}

function runBranch(ctx: GitContext, action: string): string {
  if (!ctx.branch)
    throw new Error(
      `git ${action} needs a worktree run (its own branch): this run works in place on the checkout itself`,
    );
  return ctx.branch;
}

async function hasOrigin(ctx: GitContext): Promise<boolean> {
  return (await tryGit(ctx.workspace, ['remote', 'get-url', 'origin'], ctx.env)) !== undefined;
}

/** The node's base, else where the run forked from, else the remote's default, else main/master. */
async function baseBranch(node: GitNode, ctx: GitContext, origin: boolean): Promise<string> {
  if (node.base) return node.base;
  if (ctx.base) return ctx.base;
  if (origin) {
    const head = await tryGit(
      ctx.project,
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ctx.env,
    );
    if (head) return head.replace(/^origin\//, '');
    const remote = await tryGit(ctx.project, ['ls-remote', '--symref', 'origin', 'HEAD'], ctx.env);
    const m = /^ref: refs\/heads\/(\S+)\s+HEAD/m.exec(remote ?? '');
    if (m?.[1]) return m[1];
  }
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

async function commit(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  if (!(await isRepo(ctx.workspace)))
    return {
      output: { committed: false, reason: 'not a git repository' },
      summary: 'nothing to commit: not a git repository',
    };
  // in place the workspace may be a subfolder: only what is under it is staged
  await git(ctx.workspace, ['add', '-A', '--', '.'], { env: ctx.env });
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
  // no TTY under the daemon: signing would hang on pinentry; hooks run as usual
  await git(
    ctx.workspace,
    ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', withTrailer(message, ctx.runId)],
    { env: ctx.env, timeoutMs: node.timeout_ms },
  );
  const sha = await git(ctx.workspace, ['rev-parse', 'HEAD'], { env: ctx.env });
  return {
    output: { committed: true, sha, message },
    summary: `committed ${sha.slice(0, 7)}: ${message.split('\n')[0]}`,
  };
}

async function pr(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  if (!(await isRepo(ctx.workspace)))
    return {
      output: { opened: false, reason: 'not a git repository' },
      summary: 'no pull request: not a git repository',
    };
  const branch = runBranch(ctx, 'pr');
  if (!(await hasOrigin(ctx)))
    throw new Error('no remote "origin": a pull request needs one (or use action: merge)');
  const base = await baseBranch(node, ctx, true);
  checkCancelled(ctx);
  await git(ctx.workspace, ['push', '-q', '-u', 'origin', branch], {
    env: ctx.env,
    timeoutMs: node.timeout_ms,
  });
  // an open PR for the branch is reused (a merged or closed one is not)
  const existing = await runArgv({
    argv: [
      'gh',
      'pr',
      'view',
      branch,
      '--json',
      'url,number,state',
      '-q',
      '.state + " " + .url + " " + (.number|tostring)',
    ],
    cwd: ctx.workspace,
    timeoutMs: 30_000,
    env: ctx.env,
  });
  if (existing.exitCode === 0 && existing.stdout.trim().startsWith('OPEN ')) {
    const [, url, number] = existing.stdout.trim().split(' ');
    return {
      output: { url, number: Number(number), base, branch, reused: true },
      summary: `pull request already open: ${url}`,
    };
  }
  await tryGit(ctx.workspace, ['fetch', '-q', 'origin', base], ctx.env);
  const diff =
    (await tryGit(ctx.workspace, ['diff', `origin/${base}...HEAD`], ctx.env))?.slice(0, MAX_DIFF) ??
    '';
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
    checkCancelled(ctx);
    if (!(await isRepo(ctx.workspace)))
      return {
        output: { merged: false, reason: 'not a git repository' },
        summary: 'nothing to merge: not a git repository',
      };
    const branch = runBranch(ctx, 'merge');
    ctx.log(`merge queue: landing ${branch}`);
    const origin = await hasOrigin(ctx);
    const base = await baseBranch(node, ctx, origin);
    if (branch === base) throw new Error(`the workspace is on "${base}" itself: nothing to merge`);
    // untracked files count: what the agent wrote and nobody committed must not be lost
    const dirty = await git(ctx.workspace, ['status', '--porcelain'], { env: ctx.env });
    if (dirty)
      throw new Error('the workspace has uncommitted changes: put a `commit` node before `merge`');
    // the base to land on: origin's when there is one (the local checkout may be behind or ahead)
    if (origin)
      await git(ctx.project, ['fetch', '-q', 'origin', base], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
    const target = origin ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
    const targetSha = await git(ctx.project, ['rev-parse', target], { env: ctx.env });
    const ahead = await git(ctx.workspace, ['rev-list', '--count', `${targetSha}..HEAD`], {
      env: ctx.env,
    });
    if (ahead === '0')
      return {
        output: { merged: false, reason: 'nothing to land', base },
        summary: `nothing to land on ${base}`,
      };
    // rebase the run branch on the base; a conflict aborts and fails the node
    const before = await git(ctx.workspace, ['rev-parse', 'HEAD'], { env: ctx.env });
    const rebase = await runArgv({
      argv: ['git', 'rebase', '-q', targetSha],
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
    const moved = (await git(ctx.workspace, ['rev-parse', 'HEAD'], { env: ctx.env })) !== before;
    // tests run when the base moved under the branch; the workflow's own gate covers the branch
    const tests = moved ? (node.tests ?? detectTestCommand(ctx.workspace)) : undefined;
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
    checkCancelled(ctx);
    const sha = await git(ctx.workspace, ['rev-parse', 'HEAD'], { env: ctx.env });
    // land on origin first: the remote refuses anything but a fast-forward, so nothing local
    // has moved when it fails; then the local base follows when it can
    if (origin)
      await git(ctx.project, ['push', '-q', 'origin', `${branch}:${base}`], {
        env: ctx.env,
        timeoutMs: node.timeout_ms,
      });
    let localUpdated = true;
    let note = '';
    try {
      const onBase =
        (await tryGit(ctx.project, ['rev-parse', '--abbrev-ref', 'HEAD'], ctx.env)) === base;
      if (onBase) {
        const pending = await git(ctx.project, ['status', '--porcelain', '--untracked-files=no'], {
          env: ctx.env,
        });
        if (pending) throw new Error('the checkout has uncommitted changes');
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
    } catch (e) {
      if (!origin) throw e; // without a remote, the local base is the only landing place
      localUpdated = false;
      note = `; local ${base} not updated (${e instanceof Error ? e.message.split('\n')[0] : String(e)}): pull it`;
      ctx.log(`merge queue: ${note.slice(2)}`);
    }
    return {
      output: {
        merged: true,
        base,
        sha,
        branch,
        tests: tests ?? null,
        pushed: origin,
        localUpdated,
      },
      summary: `merged ${branch} into ${base} (${sha.slice(0, 7)})${tests ? `, tests: ${tests}` : ''}${origin ? ', pushed' : ''}${note}`,
    };
  });
}

async function gh(ctx: GitContext, args: string[], timeoutMs: number): Promise<string> {
  const r = await runArgv({ argv: ['gh', ...args], cwd: ctx.workspace, timeoutMs, env: ctx.env });
  if (r.exitCode !== 0)
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr.trim() || r.stdout.trim()).slice(-800)}`,
    );
  return r.stdout.trim();
}

/** The URL when known (it carries the repository), else the number in the workspace's repository. */
const prRef = (pr: { number: number; url?: string }) => pr.url ?? String(pr.number);

function needPr(node: GitNode, ctx: GitContext): { number: number; url?: string } {
  if (!ctx.pr)
    throw new Error(
      `${node.action}: no pull request in this run (add a pr node before it, or name the PR as #N in the request)`,
    );
  return ctx.pr;
}

/** The text a node wrote, or the node's `message`. */
function textFor(node: GitNode, ctx: GitContext): string | undefined {
  const fromNode = node.from ? ctx.texts?.[node.from]?.trim() : undefined;
  return fromNode || node.message?.trim() || undefined;
}

/** `gh pr review`: a node's text as a review of the pull request (comment, approve, request changes). */
async function review(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  const target = needPr(node, ctx);
  const body = textFor(node, ctx);
  if (!body)
    return {
      output: { reviewed: false, number: target.number, reason: 'nothing to say' },
      summary: 'no review: the node wrote nothing',
    };
  const event = node.event ?? 'comment';
  checkCancelled(ctx);
  await gh(ctx, ['pr', 'review', prRef(target), `--${event}`, '--body', body], node.timeout_ms);
  return {
    output: { reviewed: true, number: target.number, url: target.url, event },
    summary: `review published on PR #${target.number} (${event})`,
  };
}

/** `gh pr comment`: a node's text (or the message) as a comment on the pull request. */
async function comment(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  const target = needPr(node, ctx);
  const body = textFor(node, ctx);
  if (!body)
    return {
      output: { commented: false, number: target.number, reason: 'nothing to say' },
      summary: 'no comment: the node wrote nothing',
    };
  checkCancelled(ctx);
  await gh(ctx, ['pr', 'comment', prRef(target), '--body', body], node.timeout_ms);
  return {
    output: { commented: true, number: target.number, url: target.url },
    summary: `comment posted on PR #${target.number}`,
  };
}

/** `gh pr merge`: the pull request merged on GitHub (squash by default), its branch deleted. */
async function mergePr(node: GitNode, ctx: GitContext): Promise<GitOutcome> {
  const target = needPr(node, ctx);
  const method = node.method ?? 'squash';
  checkCancelled(ctx);
  // no --delete-branch: gh would also switch and delete the local checkout, wrong in a worktree
  await gh(ctx, ['pr', 'merge', prRef(target), `--${method}`], node.timeout_ms);
  return {
    output: { merged: true, number: target.number, url: target.url, method },
    summary: `PR #${target.number} merged (${method})`,
  };
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
    case 'review':
      return review(node, ctx);
    case 'comment':
      return comment(node, ctx);
    case 'merge_pr':
      return mergePr(node, ctx);
  }
}
