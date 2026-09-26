import type { Envelope, InboxId, SubmitRequest } from '@shibaox/daemon';
import {
  type Accessor,
  createContext,
  createEffect,
  createRoot,
  type JSX,
  onCleanup,
  type ParentProps,
  useContext,
} from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { type Card, reduceTimeline } from '../model/stream.js';
import type { DaemonClientLike } from './client.js';
import { type DataState, FRAME_LIMIT, initialData } from './data-state.js';
import { Poller, type PollerIntervals, type PollerToast } from './poller.js';

export type { DataState } from './data-state.js';

export interface Data {
  state: DataState;
  /**
   * The session cards of a run: reconciled by key on every change, so unchanged cards and
   * blocks keep their identity and the screen updates in place instead of remounting.
   */
  timeline(runId: string): Accessor<Card[]>;
  /** How many frames of the run are held; undefined once its tab is closed. */
  frameCount(runId: string): number | undefined;
  openRun(runId: string): void;
  closeRun(runId: string): void;
  activate(runId?: string): void;
  nextTab(direction: 1 | -1): void;
  markRead(runId: string): void;
  actions: {
    answer(id: InboxId, approved: boolean, note?: string): Promise<void>;
    cancel(runId: string): Promise<void>;
    resume(runId: string, budgetUsd?: number): Promise<void>;
    submit(req: SubmitRequest): Promise<string | undefined>;
  };
  poller: Poller;
}

const Context = createContext<Data>();

export function DataProvider(
  props: ParentProps<{
    client: DaemonClientLike;
    intervals?: Partial<PollerIntervals>;
    now?: () => number;
    /** Stream mode: subscribe to this run only and never open tabs. */
    single?: string;
    /** Where the poller's toasts go (the shell passes `useToast().show`). */
    toast?: (t: PollerToast) => void;
    /** Where stream failures and malformed frames are noted. */
    log?: (line: string) => void;
  }>,
): JSX.Element {
  const [state, set] = createStore<DataState>(initialData());
  // frames stay out of the reactive store: a reduce over 20 000 proxied envelopes would
  // subscribe to every property it reads; `versions` is the only signal
  const frames = new Map<string, Envelope[]>();
  const bump = (runId: string) => set('versions', runId, (v = 0) => v + 1);
  const sink = {
    reset: (runId: string) => {
      frames.set(runId, []);
      bump(runId);
    },
    append: (runId: string, batch: Envelope[]) => {
      const all = [...(frames.get(runId) ?? []), ...batch];
      frames.set(runId, all.length > FRAME_LIMIT ? all.slice(-FRAME_LIMIT) : all);
      bump(runId);
    },
  };
  const timelines = new Map<string, { cards: Accessor<Card[]>; dispose: () => void }>();

  const activate = (runId?: string) => {
    set('active', runId);
    if (runId) set('unread', runId, undefined as never);
  };
  const openRun = (runId: string) => {
    if (!state.open.includes(runId)) set('open', (o) => [...o, runId]);
    poller.subscribe(runId);
    activate(runId);
  };
  const poller = new Poller({
    client: props.client,
    set,
    get: () => state,
    frames: sink,
    toast: (t) => props.toast?.(t),
    log: props.log,
    open: openRun,
    now: props.now,
    intervals: props.intervals,
  });
  const release = (runId: string) => {
    timelines.get(runId)?.dispose();
    timelines.delete(runId);
    frames.delete(runId);
    set('versions', runId, undefined as never);
  };
  const closeRun = (runId: string) => {
    const i = state.open.indexOf(runId);
    if (i < 0) return;
    set('open', (o) => o.filter((id) => id !== runId));
    poller.unsubscribe(runId);
    release(runId);
    if (state.active === runId) activate(state.open[Math.min(i, state.open.length - 1)]);
  };
  const nextTab = (direction: 1 | -1) => {
    const tabs = [undefined, ...state.open];
    const i = tabs.indexOf(state.active);
    activate(tabs[(i + direction + tabs.length) % tabs.length]);
  };
  const timeline = (runId: string): Accessor<Card[]> => {
    let entry = timelines.get(runId);
    if (!entry) {
      entry = createRoot((dispose) => {
        const [cards, setCards] = createStore<{ list: Card[] }>({ list: [] });
        createEffect(() => {
          state.versions[runId];
          const run = state.states[runId];
          // a malformed frame must never take the screen down: keep the last good cards and log
          try {
            const next = reduceTimeline(run, frames.get(runId) ?? []);
            setCards('list', reconcile(next, { key: 'key' }));
          } catch (e) {
            props.log?.(`timeline ${runId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
        return { cards: () => cards.list, dispose };
      });
      timelines.set(runId, entry);
    }
    return entry.cards;
  };

  poller.start();
  if (props.single) {
    set('open', [props.single]);
    set('active', props.single);
    poller.subscribe(props.single);
  }
  onCleanup(() => {
    poller.stop();
    for (const id of [...timelines.keys()]) release(id);
  });

  const value: Data = {
    state,
    timeline,
    frameCount: (runId) => frames.get(runId)?.length,
    openRun,
    closeRun,
    activate,
    nextTab,
    markRead: (runId) => set('unread', runId, undefined as never),
    actions: {
      answer: (id, approved, note) => poller.answer(id, approved, note),
      cancel: (runId) => poller.cancel(runId),
      resume: (runId, budgetUsd) => poller.resume(runId, budgetUsd),
      submit: (req) => poller.submit(req),
    },
    poller,
  };
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useData(): Data {
  const c = useContext(Context);
  if (!c) throw new Error('useData outside DataProvider');
  return c;
}
