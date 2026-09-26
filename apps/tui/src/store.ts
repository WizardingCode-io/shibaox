import { isTerminal, type RunState, type RunStatus } from '@shibaox/core';
import type { Health, InboxItem, RunSummaryPlus } from '@shibaox/daemon';
import { STREAM_LIMIT, type StreamLine } from './stream.js';

export type View = 'dashboard' | 'newRun' | 'help' | 'inboxList';
export type ToastTone = 'success' | 'danger' | 'info';

export interface AppState {
  health?: Health;
  daemonReachable: boolean;
  runs: RunSummaryPlus[];
  inbox: InboxItem[];
  selectedRunId?: string;
  runStates: Record<string, RunState>;
  streams: Record<string, StreamLine[]>;
  toast?: { text: string; tone: ToastTone; until: number };
  filter: 'active' | 'all';
  view: View;
  focus: 'list' | 'detail';
  /** False while the daemon is unreachable: action keys do nothing but a toast. */
  actionsEnabled: boolean;
}

const TOAST_MS = 5000;
const RECENT_MS = 24 * 3600_000;

const initialState = (): AppState => ({
  daemonReachable: true,
  runs: [],
  inbox: [],
  runStates: {},
  streams: {},
  filter: 'active',
  view: 'dashboard',
  focus: 'list',
  actionsEnabled: true,
});

/** The dashboard's state: immutable updates, one notification per action. */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<(s: AppState) => void>();

  constructor(initial: Partial<AppState> = {}) {
    this.state = { ...initialState(), ...initial };
  }

  get(): AppState {
    return this.state;
  }

  subscribe(l: (s: AppState) => void): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Runs to show: with `active`, non-terminal runs plus terminal ones updated in the last 24 h. */
  visibleRuns(now = Date.now()): RunSummaryPlus[] {
    const runs =
      this.state.filter === 'all'
        ? this.state.runs
        : this.state.runs.filter(
            (r) => !isTerminal(r.status as RunStatus) || now - Date.parse(r.updatedAt) <= RECENT_MS,
          );
    return [...runs].sort((a, b) => {
      const ta = isTerminal(a.status as RunStatus) ? 1 : 0;
      const tb = isTerminal(b.status as RunStatus) ? 1 : 0;
      if (ta !== tb) return ta - tb;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  setRuns(runs: RunSummaryPlus[]): void {
    this.set({ runs });
    this.ensureSelection();
  }

  private ensureSelection(): void {
    const visible = this.visibleRuns();
    const current = this.state.selectedRunId;
    if (current && visible.some((r) => r.runId === current)) return;
    this.set({ selectedRunId: visible[0]?.runId });
  }

  setInbox(inbox: InboxItem[]): void {
    this.set({ inbox });
  }

  setHealth(health?: Health): void {
    this.set({ health });
  }

  setReachable(ok: boolean): void {
    if (ok === this.state.daemonReachable) return;
    this.set({ daemonReachable: ok, actionsEnabled: ok });
  }

  select(runId: string | undefined): void {
    this.set({ selectedRunId: runId });
  }

  moveSelection(delta: 1 | -1): void {
    const visible = this.visibleRuns();
    if (visible.length === 0) return;
    const i = visible.findIndex((r) => r.runId === this.state.selectedRunId);
    const next = (i < 0 ? 0 : (i + delta + visible.length) % visible.length) as number;
    this.set({ selectedRunId: visible[next]?.runId });
  }

  setRunState(state: RunState): void {
    this.set({ runStates: { ...this.state.runStates, [state.runId]: state } });
  }

  /** Appends lines to a run's stream, keeping the last STREAM_LIMIT. */
  pushLines(runId: string, lines: StreamLine[]): void {
    const merged = [...(this.state.streams[runId] ?? []), ...lines];
    const kept = merged.length > STREAM_LIMIT ? merged.slice(merged.length - STREAM_LIMIT) : merged;
    this.set({ streams: { ...this.state.streams, [runId]: kept } });
  }

  /** Replaces a run's stream (a subscription that restarted from the beginning). */
  setLines(runId: string, lines: StreamLine[]): void {
    const kept = lines.length > STREAM_LIMIT ? lines.slice(lines.length - STREAM_LIMIT) : lines;
    this.set({ streams: { ...this.state.streams, [runId]: kept } });
  }

  showToast(text: string, tone: ToastTone, now = Date.now()): void {
    this.set({ toast: { text, tone, until: now + TOAST_MS } });
  }

  clearExpiredToast(now = Date.now()): void {
    if (this.state.toast && this.state.toast.until <= now) this.set({ toast: undefined });
  }

  setFilter(filter: 'active' | 'all'): void {
    this.set({ filter });
    this.ensureSelection();
  }

  setView(view: View): void {
    this.set({ view });
  }

  setFocus(focus: 'list' | 'detail'): void {
    this.set({ focus });
  }
}
