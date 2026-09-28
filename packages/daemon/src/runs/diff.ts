import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runArgv } from '@wizardingcode/shibaox-core';

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface DiffResult {
  /** What the patch is against (`HEAD` of the run's checkout). */
  base: string;
  files: DiffFile[];
  patch: string;
  truncated: boolean;
}

export const DIFF_PATCH_LIMIT = 2_000_000;

const git = async (cwd: string, args: string[]) =>
  (await runArgv({ argv: ['git', ...args], cwd, timeoutMs: 60_000 })).stdout;

/**
 * The commit a run's worktree forked from: the merge base of the worktree and the project's
 * current HEAD. Work the agent committed on the run branch then shows in the diff.
 */
export async function worktreeBase(worktree: string, project: string): Promise<string> {
  const head = (await git(project, ['rev-parse', 'HEAD'])).trim();
  const base = (await git(worktree, ['merge-base', 'HEAD', head])).trim();
  return base || 'HEAD';
}

function statusOf(code: string): DiffFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

/**
 * The changes of a run's checkout against `base` (its HEAD by default; the fork point for a
 * worktree run): tracked changes from `git diff` plus untracked files as additions. `undefined` when the directory is gone; the patch is capped.
 */
export async function diffWorkspace(
  path: string,
  o: { maxChars?: number; base?: string } = {},
): Promise<DiffResult | undefined> {
  if (!existsSync(path)) return undefined;
  const max = o.maxChars ?? DIFF_PATCH_LIMIT;
  const base = o.base ?? 'HEAD';
  const files: DiffFile[] = [];
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of (await git(path, ['diff', base, '--numstat'])).split('\n')) {
    const [a, d, ...rest] = line.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    counts.set(file, { additions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  for (const line of (await git(path, ['diff', base, '--name-status'])).split('\n')) {
    const [code, ...rest] = line.split('\t');
    const file = rest.at(-1);
    if (!code || !file) continue;
    files.push({
      path: file,
      status: statusOf(code),
      ...(counts.get(file) ?? { additions: 0, deletions: 0 }),
    });
  }
  let patch = await git(path, ['diff', base]);
  const untracked = (await git(path, ['status', '--porcelain', '--untracked-files=all']))
    .split('\n')
    .filter((l) => l.startsWith('?? '))
    .map((l) => l.slice(3).trim())
    .filter((f) => f && !f.endsWith('/'));
  for (const file of untracked) {
    let additions = 0;
    try {
      const text = readFileSync(join(path, file), 'utf8');
      additions = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      // unreadable (binary or vanished): counted as an empty addition
    }
    files.push({ path: file, status: 'added', additions, deletions: 0 });
    if (patch.length < max) {
      // `--no-index` exits 1 when the files differ: the stdout is still the patch
      const r = await runArgv({
        argv: ['git', 'diff', '--no-index', '--', '/dev/null', file],
        cwd: path,
        timeoutMs: 60_000,
      });
      patch += r.stdout.replace(/^diff --git a\/dev\/null b\/(.*)$/m, 'diff --git a/$1 b/$1');
    }
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  const truncated = patch.length > max;
  return { base, files, patch: truncated ? `${patch.slice(0, max)}\n…` : patch, truncated };
}
