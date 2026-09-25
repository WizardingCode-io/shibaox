import { resolve } from 'node:path';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { dbPath } from './run.js';

export async function runsCommand(orgDir: string, db?: string): Promise<void> {
  const store = new SqliteEventStore(dbPath(resolve(orgDir), db));
  try {
    const runs = await store.listRuns();
    if (runs.length === 0) console.log('no runs yet');
    for (const r of runs)
      console.log(`${r.runId}  ${r.workflow.padEnd(20)} ${r.status.padEnd(14)} ${r.updatedAt}`);
  } finally {
    store.close();
  }
}
