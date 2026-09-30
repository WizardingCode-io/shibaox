import { loadProjectFile, PROJECT_FILE } from '@wizardingcode/shibaox-schemas';

/**
 * The project's protected globs, read from the project checkout (never from a run's
 * worktree, which the model can edit): `shibaox.yaml` itself is always protected, and a file
 * that exists but does not parse refuses (a task must never run unprotected by mistake).
 */
export function projectProtectedGlobs(projectRoot: string): string[] {
  const file = loadProjectFile(projectRoot);
  return [PROJECT_FILE, ...(file?.protected ?? [])];
}
