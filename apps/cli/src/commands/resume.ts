import { resolve } from 'node:path';
import { type RunState, replay } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { loadOrg } from '@shibaox/schemas';
import { buildEngine, dbPath, type EngineOptions } from './run.js';

export interface ResumeOptions extends EngineOptions {
  org: string;
  budget?: number;
  db?: string;
}

/**
 * Continues a run from the event log: re-asks pending humans (through the
 * terminal when interactive), resumes a budget pause with `budget`, or
 * re-runs nodes interrupted by a crash.
 */
export async function resumeRun(runId: string, opts: ResumeOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    // same adapter rules as `run`: resolve the run's own workflow up front
    const events = await store.read(runId);
    const state = events.length > 0 ? replay(events) : undefined;
    const engine = buildEngine(store, org, opts, {
      workflow: state && (state.workflowSnapshot ?? org.workflows[state.workflow]),
      budgetUsd: opts.budget ?? state?.budgetUsd,
    });
    return await engine.resume(runId, { budgetUsd: opts.budget });
  } finally {
    store.close();
  }
}
