import { resolve } from 'node:path';
import { isTerminal, type RunState, replay } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { loadOrg } from '@shibaox/schemas';
import { effectiveAdapter, isAdapterId } from '../wiring.js';
import {
  buildEngine,
  dbPath,
  type EngineOptions,
  finishRun,
  logWorktree,
  prepareGraph,
  projectOf,
} from './run.js';

export interface ResumeOptions extends EngineOptions {
  org: string;
  budget?: number;
  db?: string;
}

/**
 * Continues a run from the event log: re-asks pending humans (through the
 * terminal when interactive), resumes a budget pause with `budget`, or
 * re-runs nodes interrupted by a crash. Without `adapter` it keeps the adapter
 * the run was started with. Writes the vault notes when the run ends here.
 */
export async function resumeRun(runId: string, opts: ResumeOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const events = await store.read(runId);
    const prior = events.length > 0 ? replay(events) : undefined;
    const recorded = isAdapterId(prior?.adapter) ? prior?.adapter : undefined;
    const adapter = opts.adapter ?? recorded ?? effectiveAdapter(undefined, org);
    const workflow = prior && (prior.workflowSnapshot ?? org.workflows[prior.workflow]);
    const graph = prior
      ? await prepareGraph({
          project: projectOf(prior),
          org,
          workflow,
          request: String(prior.input.spec ?? ''),
          adapter,
          opts,
        })
      : undefined;
    // same adapter rules as `run`: resolve the run's own workflow up front
    const engine = buildEngine(
      store,
      org,
      { ...opts, adapter },
      { workflow, budgetUsd: opts.budget ?? prior?.budgetUsd, graph },
    );
    const state = await engine.resume(runId, { budgetUsd: opts.budget });
    if (prior && !isTerminal(prior.status))
      await finishRun(store, org, state, { ...opts, adapter });
    logWorktree(state, opts.log ?? ((l: string) => console.log(l)));
    return state;
  } finally {
    store.close();
  }
}
