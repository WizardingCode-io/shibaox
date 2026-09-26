import { DaemonHttpError, type SubmitRequest } from '@shibaox/daemon';
import type { DaemonClientLike } from './client.js';
import type { AppStore } from './store.js';
import { applyFrame, RUN_EVENT_REFRESH, type StreamLine } from './stream.js';

export interface PollerIntervals {
  fast: number;
  normal: number;
  slow: number;
  health: number;
}

export interface PollerOptions {
  client: DaemonClientLike;
  store: AppStore;
  now?: () => number;
  intervals?: Partial<PollerIntervals>;
}

const DEFAULTS: PollerIntervals = { fast: 500, normal: 1000, slow: 5000, health: 5000 };
const FAST_WINDOW_MS = 3000;

/**
 * Feeds the store: `listRuns` + `inbox` on a timer (faster after an action, slower while the
 * daemon is unreachable), `health` on its own timer, and one SSE subscription for the
 * selected run. Actions call the client and report through toasts.
 */
export class Poller {
  private readonly client: DaemonClientLike;
  private readonly store: AppStore;
  private readonly now: () => number;
  private readonly intervals: PollerIntervals;
  private tickTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  private stream: { runId: string; controller: AbortController; cursor?: string } | undefined;
  private fastUntil = 0;
  private running = false;
  private ticking = false;

  constructor(o: PollerOptions) {
    this.client = o.client;
    this.store = o.store;
    this.now = o.now ?? (() => Date.now());
    this.intervals = { ...DEFAULTS, ...o.intervals };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribe = this.store.subscribe((s) => this.follow(s.selectedRunId));
    this.follow(this.store.get().selectedRunId);
    this.schedule(0);
    this.healthTimer = setInterval(() => void this.healthTick(), this.intervals.health);
    void this.healthTick();
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.tickTimer = undefined;
    this.healthTimer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.closeStream();
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delay);
  }

  private nextDelay(): number {
    if (!this.store.get().daemonReachable) return this.intervals.slow;
    return this.now() < this.fastUntil ? this.intervals.fast : this.intervals.normal;
  }

  /** One `listRuns` + `inbox` round; reschedules itself while started. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [runs, inbox] = await Promise.all([this.client.listRuns(), this.client.inbox()]);
      const wasDown = !this.store.get().daemonReachable;
      this.store.setReachable(true);
      this.store.setRuns(runs);
      this.store.setInbox(inbox);
      this.store.clearExpiredToast(this.now());
      if (wasDown) this.follow(this.store.get().selectedRunId, true);
    } catch {
      this.store.setReachable(false);
      this.closeStream();
    } finally {
      this.ticking = false;
      this.schedule(this.nextDelay());
    }
  }

  async healthTick(): Promise<void> {
    try {
      this.store.setHealth(await this.client.health());
    } catch {
      this.store.setHealth(undefined);
    }
  }

  /** Keeps exactly one SSE subscription, on the selected run. */
  private follow(runId: string | undefined, force = false): void {
    if (!this.running) return;
    if (!force && this.stream?.runId === runId) return;
    if (!this.store.get().daemonReachable) return;
    this.closeStream();
    if (!runId) return;
    const controller = new AbortController();
    const since = force && this.stream?.runId === runId ? this.stream.cursor : undefined;
    const stream = { runId, controller, cursor: since };
    this.stream = stream;
    void this.consume(stream);
  }

  private closeStream(): void {
    this.stream?.controller.abort();
    this.stream = undefined;
  }

  private async consume(stream: {
    runId: string;
    controller: AbortController;
    cursor?: string;
  }): Promise<void> {
    const { runId, controller } = stream;
    const mine = () => this.stream === stream && !controller.signal.aborted;
    // a fresh subscription replays the history: start the run's lines over
    if (!stream.cursor) this.store.setLines(runId, []);
    try {
      for await (const env of this.client.events(runId, {
        signal: controller.signal,
        since: stream.cursor,
      })) {
        if (!mine()) return;
        if (env.kind !== 'end') stream.cursor = env.cursor;
        const lines = this.store.get().streams[runId] ?? [];
        const next = applyFrame(lines, env);
        if (next !== lines) this.store.setLines(runId, next as StreamLine[]);
        if (env.kind === 'end' || (env.kind === 'run' && RUN_EVENT_REFRESH.has(env.event.type)))
          await this.refreshRun(runId);
        if (env.kind === 'end') {
          this.store.markEnded(runId, env.status);
          return;
        }
      }
    } catch {
      // aborted, or the daemon went away: the poll loop notices and reopens
    }
  }

  private async refreshRun(runId: string): Promise<void> {
    try {
      this.store.setRunState(await this.client.getRun(runId));
    } catch {
      // gone (404) or unreachable: the list refresh handles it
    }
  }

  private toastError(e: unknown, fallback: string): void {
    if (e instanceof DaemonHttpError && e.status === 409 && /already answered/i.test(e.message)) {
      this.store.showToast('Already answered elsewhere', 'info', this.now());
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    this.store.showToast(message || fallback, 'danger', this.now());
  }

  private afterAction(): void {
    this.fastUntil = this.now() + FAST_WINDOW_MS;
    this.schedule(0);
  }

  async answer(id: string, approved: boolean, note?: string): Promise<void> {
    try {
      await this.client.answer(id, { approved, note, via: 'cli' });
      this.store.showToast(approved ? 'Approved' : 'Denied', 'success', this.now());
    } catch (e) {
      this.toastError(e, 'Could not record the answer');
    }
    this.afterAction();
  }

  async cancel(runId: string): Promise<void> {
    try {
      const s = await this.client.cancel(runId);
      this.store.setRunState(s);
      this.store.showToast(`Run ${runId.slice(0, 8)} cancelled`, 'success', this.now());
    } catch (e) {
      this.toastError(e, 'Could not cancel the run');
    }
    this.afterAction();
  }

  async resume(runId: string, budgetUsd?: number): Promise<void> {
    try {
      const s = await this.client.resume(runId, { budgetUsd });
      this.store.setRunState(s);
      this.store.showToast(`Run ${runId.slice(0, 8)} resumed`, 'success', this.now());
    } catch (e) {
      this.toastError(e, 'Could not resume the run');
    }
    this.afterAction();
  }

  /** Submits a run and selects it; returns its id, or undefined on failure (toast shown). */
  async submit(req: SubmitRequest): Promise<string | undefined> {
    try {
      const { runId, warnings } = await this.client.submitRun(req);
      const note = warnings.length ? ` (${warnings.join('; ')})` : '';
      this.store.showToast(`Run ${runId.slice(0, 8)} queued${note}`, 'success', this.now());
      this.store.select(runId);
      this.afterAction();
      return runId;
    } catch (e) {
      this.toastError(e, 'Could not submit the run');
      this.afterAction();
      return undefined;
    }
  }
}
