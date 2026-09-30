import type { RunState } from '@wizardingcode/shibaox-core';
import type { Envelope, InboxId, SubmitRequest } from '@wizardingcode/shibaox-daemon';
import { DaemonHttpError } from '@wizardingcode/shibaox-daemon/client';
import type { SetStoreFunction } from 'solid-js/store';
import { RUN_EVENT_REFRESH } from '../model/stream.js';
import type { Feedback } from '../theme/resolve.js';
import type { DaemonClientLike } from './client.js';
import type { DataState } from './data-state.js';

export interface PollerIntervals {
  fast: number;
  normal: number;
  slow: number;
  health: number;
}

export interface PollerToast {
  message: string;
  variant: Feedback;
  action?: { label: string; run: () => void };
}

/** Where the frames of a run go: a plain array per run, outside the reactive store. */
export interface FrameSink {
  reset(runId: string): void;
  append(runId: string, batch: Envelope[]): void;
}

export interface PollerOptions {
  client: DaemonClientLike;
  set: SetStoreFunction<DataState>;
  get: () => DataState;
  frames: FrameSink;
  toast: (t: PollerToast) => void;
  /** Opens a run's tab (the toast's Open action). */
  open?: (runId: string) => void;
  /** Where stream failures and malformed frames are noted (`~/.shibaox/tui.log`). */
  log?: (line: string) => void;
  now?: () => number;
  intervals?: Partial<PollerIntervals>;
}

interface Sub {
  runId: string;
  controller: AbortController;
  cursor?: string;
  /** Frames received but not yet written to the store (flushed every FLUSH_MS). */
  pending: Envelope[];
  flushTimer?: NodeJS.Timeout;
  /** The stream closed without an `end` frame (daemon restart, socket error): reopen on the next tick. */
  broken?: boolean;
}

const DEFAULTS: PollerIntervals = { fast: 500, normal: 1000, slow: 5000, health: 5000 };
const FAST_WINDOW_MS = 3000;
const REFRESH_THROTTLE_MS = 200;
/** Frames are written to the store in batches: one store update per burst, not per frame. */
const FLUSH_MS = 50;

/**
 * Feeds the data store: `listRuns` + `inbox` on a timer (faster after an action, slower while
 * the daemon is unreachable), `health` on its own timer, and one SSE subscription per open tab
 * (reopened with its cursor when the daemon comes back). Actions call the client and toast.
 */
export class Poller {
  private readonly client: DaemonClientLike;
  private readonly set: SetStoreFunction<DataState>;
  private readonly get: () => DataState;
  private readonly frames: FrameSink;
  private readonly toast: (t: PollerToast) => void;
  private readonly open: (runId: string) => void;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly intervals: PollerIntervals;
  private tickTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private readonly subs = new Map<string, Sub>();
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private fastUntil = 0;
  private running = false;
  private ticking = false;

  constructor(o: PollerOptions) {
    this.client = o.client;
    this.set = o.set;
    this.get = o.get;
    this.frames = o.frames;
    this.toast = o.toast;
    this.open = o.open ?? (() => undefined);
    this.log = o.log ?? (() => undefined);
    this.now = o.now ?? (() => Date.now());
    this.intervals = { ...DEFAULTS, ...o.intervals };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
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
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    for (const runId of [...this.subs.keys()]) this.close(runId);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delay);
  }

  private nextDelay(): number {
    if (!this.get().reachable) return this.intervals.slow;
    return this.now() < this.fastUntil ? this.intervals.fast : this.intervals.normal;
  }

  /** One `listRuns` + `inbox` round; reschedules itself while started. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const [runs, inbox] = await Promise.all([this.client.listRuns(), this.client.inbox()]);
      const wasDown = !this.get().reachable;
      this.set('reachable', true);
      this.set('unreachableSince', undefined);
      this.set('runs', runs);
      this.set('inbox', inbox);
      for (const sub of [...this.subs.values()]) if (wasDown || sub.broken) this.reopen(sub);
    } catch {
      if (this.get().reachable) {
        this.set('reachable', false);
        this.set('unreachableSince', this.now());
      }
      for (const sub of this.subs.values()) sub.controller.abort();
    } finally {
      this.ticking = false;
      this.schedule(this.nextDelay());
    }
  }

  async healthTick(): Promise<void> {
    try {
      this.set('health', await this.client.health());
    } catch {
      this.set('health', undefined);
    }
  }

  /** Opens the run's SSE stream (history first); a no-op when already subscribed. */
  subscribe(runId: string): void {
    if (this.subs.has(runId)) return;
    const sub: Sub = { runId, controller: new AbortController(), pending: [] };
    this.subs.set(runId, sub);
    if (this.get().reachable) void this.consume(sub);
  }

  unsubscribe(runId: string): void {
    this.close(runId);
  }

  private close(runId: string): void {
    const sub = this.subs.get(runId);
    if (!sub) return;
    this.flush(sub);
    sub.controller.abort();
    this.subs.delete(runId);
  }

  private flush(sub: Sub): void {
    if (sub.flushTimer) clearTimeout(sub.flushTimer);
    sub.flushTimer = undefined;
    if (sub.pending.length === 0) return;
    const batch = sub.pending;
    sub.pending = [];
    this.frames.append(sub.runId, batch);
  }

  private queue(sub: Sub, env: Envelope): void {
    sub.pending.push(env);
    if (!sub.flushTimer) sub.flushTimer = setTimeout(() => this.flush(sub), FLUSH_MS);
  }

  private reopen(old: Sub): void {
    this.flush(old);
    old.controller.abort();
    const sub: Sub = {
      runId: old.runId,
      controller: new AbortController(),
      cursor: old.cursor,
      pending: [],
    };
    this.subs.set(old.runId, sub);
    void this.consume(sub);
  }

  private async consume(sub: Sub): Promise<void> {
    const { runId, controller } = sub;
    const mine = () => this.subs.get(runId) === sub && !controller.signal.aborted;
    let ended = false;
    // a fresh subscription replays the history: start the run's frames over, and show the
    // run's nodes right away instead of waiting for its first event
    if (!sub.cursor) this.frames.reset(runId);
    await this.refreshRun(runId);
    if (!mine()) return;
    try {
      for await (const env of this.client.events(runId, {
        signal: controller.signal,
        since: sub.cursor,
      })) {
        if (!mine()) return;
        if (env.kind !== 'end') {
          sub.cursor = env.cursor;
          this.queue(sub, env);
        }
        if (env.kind === 'run' && RUN_EVENT_REFRESH.has(env.event.type)) this.refreshSoon(runId);
        if (env.kind === 'end') {
          ended = true;
          this.flush(sub);
          await this.refreshRun(runId);
          this.set('ended', runId, env.status);
          this.subs.delete(runId);
          if (this.get().active !== runId) {
            this.set('unread', runId, 'done');
            const failed = env.status !== 'completed';
            this.toast({
              message: `Run ${runId.slice(0, 8)} ${failed ? env.status : 'is done'}`,
              variant: failed ? 'error' : 'success',
              action: { label: 'Open', run: () => this.open(runId) },
            });
          }
          return;
        }
      }
    } catch (e) {
      // aborted, or the daemon went away: the poll loop notices and reopens
      if (!controller.signal.aborted)
        this.log(`stream ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // closed without an end frame while still ours: the next successful tick reopens it
      if (!ended && mine()) sub.broken = true;
    }
  }

  /** While the daemon is known as down, actions only say so (no call, no error toast). */
  private down(): boolean {
    if (this.get().reachable) return false;
    this.toast({ message: 'Daemon unreachable', variant: 'info' });
    return true;
  }

  private refreshSoon(runId: string): void {
    if (this.refreshTimers.has(runId)) return;
    this.refreshTimers.set(
      runId,
      setTimeout(() => {
        this.refreshTimers.delete(runId);
        void this.refreshRun(runId);
      }, REFRESH_THROTTLE_MS),
    );
  }

  /** Fetches the run's state; marks it unread as "needs" when it waits and is not active. */
  async refreshRun(runId: string): Promise<void> {
    try {
      const state = await this.client.getRun(runId);
      this.setState(state);
    } catch {
      // gone (404) or unreachable: the list refresh handles it
    }
  }

  private setState(state: RunState): void {
    const before = this.get().states[state.runId];
    // read through the store proxy before writing: it reflects the write immediately
    const waited = (before?.pendingApprovals.length ?? 0) + (before?.pendingHumans.length ?? 0) > 0;
    this.set('states', state.runId, state);
    const waits = state.pendingApprovals.length + state.pendingHumans.length > 0;
    if (waits && !waited && this.get().active !== state.runId)
      this.set('unread', state.runId, 'needs');
  }

  private toastError(e: unknown, fallback: string): void {
    if (e instanceof DaemonHttpError && e.status === 409 && /already answered/i.test(e.message)) {
      this.toast({ message: 'Already answered elsewhere', variant: 'info' });
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    this.toast({ message: message || fallback, variant: 'error' });
  }

  private afterAction(): void {
    this.fastUntil = this.now() + FAST_WINDOW_MS;
    this.schedule(0);
  }

  async answer(id: InboxId, approved: boolean, note?: string): Promise<void> {
    if (this.down()) return;
    try {
      await this.client.answer(id, { approved, note, via: 'cli' });
      this.toast({ message: approved ? 'Approved' : 'Denied', variant: 'success' });
    } catch (e) {
      this.toastError(e, 'Could not record the answer');
    }
    this.afterAction();
  }

  async steer(runId: string, note: string): Promise<void> {
    try {
      this.setState(await this.client.steer(runId, { note }));
      this.toast({
        message: `Run ${runId.slice(0, 8)} steered: the task starts again with your note`,
        variant: 'success',
      });
    } catch (e) {
      this.toastError(e, 'Could not steer the run');
    }
  }

  async cancel(runId: string): Promise<void> {
    if (this.down()) return;
    try {
      this.setState(await this.client.cancel(runId));
      this.toast({ message: `Run ${runId.slice(0, 8)} cancelled`, variant: 'success' });
    } catch (e) {
      this.toastError(e, 'Could not cancel the run');
    }
    this.afterAction();
  }

  async resume(runId: string, budgetUsd?: number): Promise<void> {
    if (this.down()) return;
    try {
      this.setState(await this.client.resume(runId, { budgetUsd }));
      this.toast({ message: `Run ${runId.slice(0, 8)} resumed`, variant: 'success' });
    } catch (e) {
      this.toastError(e, 'Could not resume the run');
    }
    this.afterAction();
  }

  /** Submits a run; returns its id, or undefined on failure (toast shown). */
  async submit(req: SubmitRequest): Promise<string | undefined> {
    if (this.down()) return undefined;
    try {
      const { runId, warnings } = await this.client.submitRun(req);
      const note = warnings.length ? ` (${warnings.join('; ')})` : '';
      this.toast({ message: `Run ${runId.slice(0, 8)} queued${note}`, variant: 'success' });
      this.afterAction();
      return runId;
    } catch (e) {
      this.toastError(e, 'Could not submit the run');
      this.afterAction();
      return undefined;
    }
  }
}
