import { resolve } from 'node:path';
import { replay } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { dbPath, printState } from './run.js';

export async function replayCommand(runId: string, orgDir: string, db?: string): Promise<void> {
  const store = new SqliteEventStore(dbPath(resolve(orgDir), db));
  try {
    const events = await store.read(runId);
    if (events.length === 0) {
      console.log(`run ${runId} not found`);
      return;
    }
    for (const e of events)
      console.log(
        `${String(e.seq).padStart(4)}  ${e.at}  ${e.type}${'nodeId' in e ? ` ${e.nodeId}` : ''}${e.type === 'NodeFailed' ? `  ${e.error}` : ''}`,
      );
    printState(replay(events));
  } finally {
    store.close();
  }
}
