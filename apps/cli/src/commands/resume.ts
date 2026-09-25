import { resolve } from 'node:path';
import type { RunState } from '@shibaox/core';
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
    return await buildEngine(store, org, opts).resume(runId, { budgetUsd: opts.budget });
  } finally {
    store.close();
  }
}
