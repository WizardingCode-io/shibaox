import { resolve } from 'node:path';
import { type EventStore, isTerminal, type RunState } from '@shibaox/core';
import { writeDecisionNote, writeRunNote } from '@shibaox/memory';
import type { Org } from '@shibaox/schemas';
import type { AdapterId } from '../runtime.js';
import { projectName, projectOf, worktreeOf } from './workspace.js';

export interface NotesOptions {
  log: (line: string) => void;
  /** Vault directory; overrides `vault:` in org.yaml. */
  vault?: string;
}

/** The vault of an org: the daemon override, else `vault:` in org.yaml (relative to the org). */
export function vaultDir(org: Org, opts: { vault?: string }): string | undefined {
  if (opts.vault) return resolve(opts.vault);
  return org.org.vault ? resolve(org.root, org.org.vault) : undefined;
}

/** Writes the run note and one decision note per `decide` node once the run is terminal. */
export async function finishRun(
  store: EventStore,
  org: Org,
  state: RunState,
  opts: NotesOptions & { adapter: AdapterId },
): Promise<void> {
  if (!isTerminal(state.status)) return;
  const log = opts.log;
  const vault = vaultDir(org, opts);
  if (!vault) {
    log('warn: no vault in org.yaml: run notes are not written');
    return;
  }
  const workflow = state.workflowSnapshot ?? org.workflows[state.workflow];
  if (!workflow) return;
  try {
    const events = await store.read(state.runId);
    const project = projectName(projectOf(state));
    const note = writeRunNote({
      vault,
      project,
      state,
      events,
      workflow,
      adapter: state.adapter ?? opts.adapter,
    });
    log(`note: ${note.path}`);
    for (const [nodeId, node] of Object.entries(workflow.nodes))
      if (node.type === 'decide' && state.nodes[nodeId]?.choice)
        log(`note: ${writeDecisionNote({ vault, project, state, nodeId, events }).path}`);
  } catch (err) {
    log(`warn: vault note not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Where a `worktree` run lives (kept for the user to review and merge), printed at the end. */
export function logWorktree(state: RunState, log: (l: string) => void): void {
  const wt = worktreeOf(state);
  if (wt) log(`worktree: ${wt.path} (branch ${state.branch ?? `shibaox/${state.runId}`})`);
}
