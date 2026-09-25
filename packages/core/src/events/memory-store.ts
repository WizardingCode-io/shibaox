import { type RunEvent, RunEventSchema } from '@shibaox/schemas';
import { replay } from '../run/reducer.js';
import type { EventStore, RunSummary, StoredEvent } from './store.js';

export class MemoryEventStore implements EventStore {
  private events: StoredEvent[] = [];
  private seq = 0;

  async append(event: RunEvent): Promise<StoredEvent> {
    const stored = { ...RunEventSchema.parse(event), seq: ++this.seq };
    this.events.push(stored);
    return stored;
  }

  async read(runId: string): Promise<StoredEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async listRuns(): Promise<RunSummary[]> {
    const byRun = new Map<string, StoredEvent[]>();
    for (const e of this.events) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
    return [...byRun.entries()].map(([runId, evs]) => {
      const state = replay(evs);
      return {
        runId,
        workflow: state.workflow,
        status: state.status,
        createdAt: evs[0]!.at,
        updatedAt: evs[evs.length - 1]!.at,
      };
    });
  }
}
