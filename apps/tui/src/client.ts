import type { RunState } from '@shibaox/core';
import type { Envelope, Health, InboxItem, RunSummaryPlus, SubmitRequest } from '@shibaox/daemon';

/** The subset of the daemon client the dashboard uses; the fake implements it in tests. */
export interface DaemonClientLike {
  health(): Promise<Health>;
  listRuns(q?: { status?: string; org?: string }): Promise<RunSummaryPlus[]>;
  getRun(id: string): Promise<RunState>;
  events(
    id: string,
    o?: { since?: string; signal?: AbortSignal; historyOnly?: boolean },
  ): AsyncIterable<Envelope>;
  inbox(): Promise<InboxItem[]>;
  answer(
    id: string,
    a: { approved: boolean; note?: string; via?: 'cli' | 'api' },
  ): Promise<{ runId: string; kind: 'human' | 'approval' }>;
  cancel(id: string): Promise<RunState>;
  resume(id: string, o?: { budgetUsd?: number }): Promise<RunState>;
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }>;
}
