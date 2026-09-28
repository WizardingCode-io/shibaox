import type { RunEvent } from '@wizardingcode/shibaox-schemas';
import type { RunStatus } from '../run/state.js';

export type StoredEvent = RunEvent & { seq: number };

export interface RunSummary {
  runId: string;
  workflow: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EventStore {
  append(event: RunEvent): Promise<StoredEvent>;
  read(runId: string): Promise<StoredEvent[]>;
  listRuns(): Promise<RunSummary[]>;
  /** Called after every successful append; returns the unsubscribe function. */
  subscribe(listener: (e: StoredEvent) => void): () => void;
}
