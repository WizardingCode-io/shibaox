import type { ProjectProfile, RunState } from '@shibaox/core';
import type {
  DiffResult,
  Envelope,
  Health,
  InboxItem,
  RunSummaryPlus,
  SubmitRequest,
} from '@shibaox/daemon';
import { DaemonHttpError } from '@shibaox/daemon/client';
import type { DaemonClientLike } from '../context/client.js';

interface Stream {
  queue: Envelope[];
  wake?: () => void;
  closed: boolean;
}

/** An in-memory daemon: lists, states and SSE frames the tests push in; every call is recorded. */
export class FakeDaemonClient implements DaemonClientLike {
  runs: RunSummaryPlus[] = [];
  states = new Map<string, RunState>();
  inboxItems: InboxItem[] = [];
  healthValue: Health = {
    version: '0.0.1',
    uptimeSeconds: 1,
    runs: { running: 0, queued: 0, waiting: 0 },
    channels: [],
  };
  calls: { method: string; args: unknown[] }[] = [];
  /** When true every call rejects with `Error('down')` (the daemon is unreachable). */
  failing = false;
  /** When set, `answer()` throws this as a DaemonHttpError. */
  answerError?: { status: number; code: string; message: string };
  submitResult: { runId: string; warnings: string[] } = { runId: 'new-run', warnings: [] };
  /** Frames every new `events()` of that run starts with (the daemon's history replay). */
  history = new Map<string, Envelope[]>();
  /** Diff results by run id; a missing entry is a 404 `no_workspace`. */
  diffs = new Map<string, DiffResult>();
  /** Project profiles by path; a missing entry is a 404 `not_found`. */
  profiles = new Map<string, ProjectProfile>();
  private readonly streams = new Map<string, Stream>();

  private record(method: string, args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failing) throw new Error('down');
  }

  async health(): Promise<Health> {
    this.record('health', []);
    return this.healthValue;
  }

  async listRuns(q?: { status?: string; org?: string }): Promise<RunSummaryPlus[]> {
    this.record('listRuns', [q]);
    return this.runs;
  }

  async getRun(id: string): Promise<RunState> {
    this.record('getRun', [id]);
    const s = this.states.get(id);
    if (!s) throw new DaemonHttpError(404, 'not_found', `run ${id} not found`);
    return s;
  }

  async inbox(): Promise<InboxItem[]> {
    this.record('inbox', []);
    return this.inboxItems;
  }

  async answer(
    id: string,
    a: { approved: boolean; note?: string; via?: 'cli' | 'api' },
  ): Promise<{ runId: string; kind: 'human' | 'approval' }> {
    this.record('answer', [id, a]);
    if (this.answerError)
      throw new DaemonHttpError(
        this.answerError.status,
        this.answerError.code,
        this.answerError.message,
      );
    const item = this.inboxItems.find((i) => i.id === id);
    return { runId: item?.runId ?? 'r', kind: item?.kind ?? 'human' };
  }

  async cancel(id: string): Promise<RunState> {
    this.record('cancel', [id]);
    const s = this.states.get(id);
    if (!s) throw new DaemonHttpError(404, 'not_found', `run ${id} not found`);
    return { ...s, status: 'cancelled' };
  }

  async resume(id: string, o?: { budgetUsd?: number }): Promise<RunState> {
    this.record('resume', [id, o]);
    const s = this.states.get(id);
    if (!s) throw new DaemonHttpError(404, 'not_found', `run ${id} not found`);
    return s;
  }

  async submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }> {
    this.record('submitRun', [req]);
    return this.submitResult;
  }

  async diff(id: string): Promise<DiffResult> {
    this.record('diff', [id]);
    const d = this.diffs.get(id);
    if (!d) throw new DaemonHttpError(404, 'no_workspace', 'The run workspace is gone');
    return d;
  }

  async projectProfile(path: string, orgRoot?: string): Promise<ProjectProfile> {
    this.record('projectProfile', [path, orgRoot]);
    const p = this.profiles.get(path);
    if (!p) throw new DaemonHttpError(404, 'not_found', `project path not found: ${path}`);
    return p;
  }

  events(
    id: string,
    o: { since?: string; signal?: AbortSignal; historyOnly?: boolean } = {},
  ): AsyncIterable<Envelope> {
    this.calls.push({ method: 'events', args: [id, o] });
    const failing = this.failing;
    const stream: Stream = { queue: [...(this.history.get(id) ?? [])], closed: false };
    this.streams.set(id, stream);
    const close = () => {
      stream.closed = true;
      if (this.streams.get(id) === stream) this.streams.delete(id);
      stream.wake?.();
    };
    o.signal?.addEventListener('abort', close, { once: true });
    async function* gen(): AsyncGenerator<Envelope> {
      if (failing) {
        close();
        throw new Error('down');
      }
      try {
        while (true) {
          while (stream.queue.length > 0) {
            const env = stream.queue.shift() as Envelope;
            yield env;
            if (env.kind === 'end') return;
            // one frame per macrotask, like frames arriving on a socket
            await new Promise((r) => setImmediate(r));
          }
          if (stream.closed) return;
          await new Promise<void>((r) => {
            stream.wake = r;
          });
          stream.wake = undefined;
        }
      } finally {
        close();
      }
    }
    return gen();
  }

  /** Delivers a frame to the live `events()` iterator of `runId` (dropped when there is none). */
  pushFrame(runId: string, env: Envelope): void {
    const s = this.streams.get(runId);
    if (!s || s.closed) return;
    s.queue.push(env);
    s.wake?.();
  }

  /** Ends the live `events()` iterator of `runId` without an `end` frame (a dropped connection). */
  closeStream(runId: string): void {
    const s = this.streams.get(runId);
    if (!s) return;
    s.closed = true;
    this.streams.delete(runId);
    s.wake?.();
  }

  /** Run ids with a live `events()` iterator. */
  openStreams(): string[] {
    return [...this.streams.entries()].filter(([, s]) => !s.closed).map(([id]) => id);
  }
}
