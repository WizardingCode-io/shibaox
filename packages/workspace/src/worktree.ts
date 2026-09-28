import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runArgv } from '@shibaox/core';

const RUN_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validateRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId) || runId.includes('..')) {
    throw new Error(`invalid runId "${runId}"`);
  }
}

export type WorkspaceMode = 'inplace' | 'worktree';
export interface RunWorkspace {
  path: string;
  mode: WorkspaceMode;
  branch?: string;
  /** The branch the project was on when the worktree was cut (the fork point). */
  baseBranch?: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runArgv({ argv: ['git', ...args], cwd, timeoutMs: 60_000 });
  if (r.exitCode !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await runArgv({
    argv: ['git', 'rev-parse', '--is-inside-work-tree'],
    cwd: dir,
    timeoutMs: 10_000,
  });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/**
 * Whether `project` can run in a worktree: the repository needs a commit (a worktree of an
 * unborn branch is empty), and a project that is a subfolder of the repository must be
 * tracked at `HEAD` (else the subfolder does not exist in the worktree).
 */
export async function worktreePreflight(
  project: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const run = (argv: string[]) => runArgv({ argv, cwd: project, timeoutMs: 10_000 });
  if ((await run(['git', 'rev-parse', '--verify', '-q', 'HEAD'])).exitCode !== 0)
    return { ok: false, reason: 'project has no commits' };
  const prefix = await run(['git', 'rev-parse', '--show-prefix']);
  const rel = prefix.exitCode === 0 ? prefix.stdout.trim().replace(/\/$/, '') : '';
  if (rel && (await run(['git', 'cat-file', '-e', `HEAD:${rel}`])).exitCode !== 0)
    return { ok: false, reason: `project "${rel}" is not tracked at HEAD` };
  return { ok: true };
}

/** Entries added to the repository's `info/exclude`: run state and the knowledge graph. */
export const EXCLUDED = ['.shibaox/', 'graphify-out/'];

async function ensureExcluded(project: string): Promise<void> {
  const commonDir = (await git(project, ['rev-parse', '--git-common-dir'])).trim();
  const gitCommonDir = resolve(project, commonDir);
  const infoDir = join(gitCommonDir, 'info');
  const exclude = join(infoDir, 'exclude');
  if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const lines = current.split('\n');
  const missing = EXCLUDED.filter((e) => !lines.includes(e));
  if (missing.length > 0)
    appendFileSync(
      exclude,
      `${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.map((e) => `${e}\n`).join('')}`,
    );
}

export async function createRunWorkspace(args: {
  project: string;
  runId: string;
  mode: WorkspaceMode;
}): Promise<RunWorkspace> {
  validateRunId(args.runId);
  if (args.mode === 'inplace') return { path: args.project, mode: 'inplace' };
  if (!(await isGitRepo(args.project)))
    throw new Error(`project "${args.project}" is not a git repository; use --workspace inplace`);
  await ensureExcluded(args.project);
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  const branch = `shibaox/${args.runId}`;
  mkdirSync(join(args.project, '.shibaox', 'worktrees'), { recursive: true });
  const head = (await git(args.project, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  await git(args.project, ['worktree', 'add', '-q', path, '-b', branch]);
  return { path, mode: 'worktree', branch, ...(head !== 'HEAD' ? { baseBranch: head } : {}) };
}

export async function listRunWorkspaces(
  project: string,
): Promise<{ runId: string; path: string; branch: string }[]> {
  const out = await git(project, ['worktree', 'list', '--porcelain']);
  const items: { runId: string; path: string; branch: string }[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of `${out}\n`.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && current.path) {
      if (current.branch?.startsWith('shibaox/'))
        items.push({
          runId: current.branch.slice('shibaox/'.length),
          path: current.path,
          branch: current.branch,
        });
      current = {};
    }
  }
  return items;
}

export async function removeRunWorkspace(args: {
  project: string;
  runId: string;
  deleteBranch?: boolean;
}): Promise<void> {
  validateRunId(args.runId);
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  await git(args.project, ['worktree', 'remove', '--force', path]);
  if (args.deleteBranch) await git(args.project, ['branch', '-D', `shibaox/${args.runId}`]);
}

/** New files beyond this many are counted, not shown: a stray build output must not flood a review. */
const MAX_NEW_FILES = 200;

/**
 * What changed in a run's checkout, for judges and reviews: tracked changes against HEAD plus
 * every new (untracked, not ignored) file under `path` as an addition, so what the agent just
 * wrote is reviewed too. Paths come from `ls-files -z`: relative to `path`, never quoted.
 */
export async function diffRunWorkspace(path: string, maxChars = 200_000): Promise<string> {
  const run = (argv: string[]) => runArgv({ argv, cwd: path, timeoutMs: 60_000 });
  let diff = (await run(['git', 'diff', 'HEAD', '--', '.'])).stdout;
  const untracked = (
    await run(['git', 'ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
  ).stdout
    .split('\0')
    .filter((f) => f);
  const shown = untracked.slice(0, MAX_NEW_FILES);
  for (const file of shown) {
    if (diff.length >= maxChars) break;
    // `--no-index` exits 1 when the files differ: the stdout is still the patch
    diff += (await run(['git', 'diff', '--no-index', '--', '/dev/null', file])).stdout;
  }
  if (untracked.length > shown.length)
    diff += `\n…${untracked.length - shown.length} more new file(s) not shown\n`;
  const status = (await run(['git', 'status', '--porcelain', '--', '.'])).stdout;
  const text = `${diff}\n## status\n${status}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}
