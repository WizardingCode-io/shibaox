import { existsSync, statSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { type RunState, runArgv } from '@shibaox/core';
import { isGitRepo, type WorkspaceMode, worktreePreflight } from '@shibaox/workspace';

export function assertProjectDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`project path not found: ${path}`);
}

/**
 * For a `worktree` run, the main project and the worktree directory
 * (`<project>/.shibaox/worktrees/<runId>`). Uses the `project` recorded at `RunCreated`; older
 * runs fall back to parsing the workspace (`<project>/.shibaox/worktrees/<runId>[/<subdir>]`).
 */
export function worktreeOf(state: RunState): { project: string; path: string } | undefined {
  if (state.workspaceMode !== 'worktree') return undefined;
  if (state.project)
    return {
      project: state.project,
      path: join(state.project, '.shibaox', 'worktrees', state.runId),
    };
  const marker = `${sep}.shibaox${sep}worktrees${sep}${state.runId}`;
  const i = state.workspace.lastIndexOf(marker);
  if (i <= 0) return undefined;
  return {
    project: state.workspace.slice(0, i),
    path: state.workspace.slice(0, i + marker.length),
  };
}

/** The main project of a run (not its worktree). */
export function projectOf(state: RunState): string {
  return state.project ?? worktreeOf(state)?.project ?? state.workspace;
}

/** The project's name for vault paths (a safe identifier). */
export function projectName(project: string): string {
  const name = basename(project).replace(/[^A-Za-z0-9._-]/g, '-');
  return name && !name.includes('..') ? name : 'project';
}

/** Path prefix of `project` inside its git repository (`''` at the top level). */
export async function gitPrefix(project: string): Promise<string> {
  const r = await runArgv({
    argv: ['git', 'rev-parse', '--show-prefix'],
    cwd: project,
    timeoutMs: 10_000,
  });
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

/**
 * `explicit`, else `worktree` in a git repository and `inplace` elsewhere. A worktree needs a
 * commit and, for a subfolder of the repository, that subfolder tracked at HEAD: a defaulted
 * worktree falls back to `inplace` with a warning, an explicit one is refused.
 */
export async function workspaceMode(
  project: string,
  explicit: WorkspaceMode | undefined,
  log: (l: string) => void,
): Promise<WorkspaceMode> {
  if (explicit === 'inplace') return 'inplace';
  if (!explicit && !(await isGitRepo(project))) return 'inplace';
  if (explicit === 'worktree' && !(await isGitRepo(project))) return 'worktree'; // createRunWorkspace explains
  const pre = await worktreePreflight(project);
  if (pre.ok) return 'worktree';
  if (explicit)
    throw new Error(
      `cannot use a worktree: ${pre.reason}; commit first or use --workspace inplace`,
    );
  log(`warn: ${pre.reason}; running in place`);
  return 'inplace';
}
