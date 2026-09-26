import { resolve } from 'node:path';
import { listRunWorkspaces, removeRunWorkspace } from '@shibaox/workspace';

/** `shibaox worktree list`: the run worktrees (`shibaox/<runId>` branches) of a project. */
export async function worktreeList(
  o: { project: string },
  log: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  const items = await listRunWorkspaces(resolve(o.project));
  if (items.length === 0) {
    log('no run worktrees');
    return;
  }
  for (const w of items) log(`${w.runId}  ${w.branch}  ${w.path}`);
}

/** `shibaox worktree rm <runId>`: removes a run worktree (and its branch with `deleteBranch`). */
export async function worktreeRemove(
  runId: string,
  o: { project: string; deleteBranch?: boolean },
  log: (line: string) => void = (l) => console.log(l),
): Promise<void> {
  await removeRunWorkspace({ project: resolve(o.project), runId, deleteBranch: o.deleteBranch });
  log(`removed worktree for ${runId}${o.deleteBranch ? ` and branch shibaox/${runId}` : ''}`);
}
