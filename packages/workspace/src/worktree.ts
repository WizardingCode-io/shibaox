import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runArgv } from '@shibaox/core';

export type WorkspaceMode = 'inplace' | 'worktree';
export interface RunWorkspace {
  path: string;
  mode: WorkspaceMode;
  branch?: string;
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

function ensureExcluded(project: string): void {
  const exclude = join(project, '.git', 'info', 'exclude');
  if (!existsSync(join(project, '.git', 'info')))
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.shibaox/'))
    appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.shibaox/\n`);
}

export async function createRunWorkspace(args: {
  project: string;
  runId: string;
  mode: WorkspaceMode;
}): Promise<RunWorkspace> {
  if (args.mode === 'inplace') return { path: args.project, mode: 'inplace' };
  if (!(await isGitRepo(args.project)))
    throw new Error(`project "${args.project}" is not a git repository; use --workspace inplace`);
  ensureExcluded(args.project);
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  const branch = `shibaox/${args.runId}`;
  mkdirSync(join(args.project, '.shibaox', 'worktrees'), { recursive: true });
  await git(args.project, ['worktree', 'add', '-q', path, '-b', branch]);
  return { path, mode: 'worktree', branch };
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
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  await git(args.project, ['worktree', 'remove', '--force', path]);
  if (args.deleteBranch) await git(args.project, ['branch', '-D', `shibaox/${args.runId}`]);
}

export async function diffRunWorkspace(path: string, maxChars = 200_000): Promise<string> {
  const diff = (await runArgv({ argv: ['git', 'diff', 'HEAD'], cwd: path, timeoutMs: 60_000 }))
    .stdout;
  const status = (
    await runArgv({ argv: ['git', 'status', '--porcelain'], cwd: path, timeoutMs: 60_000 })
  ).stdout;
  const text = `${diff}\n## status\n${status}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}
