import type { InboxId, SubmitRequest } from '@shibaox/daemon';
import {
  type Accessor,
  createContext,
  createMemo,
  getOwner,
  type JSX,
  onCleanup,
  type ParentProps,
  runWithOwner,
  useContext,
} from 'solid-js';
import { createStore } from 'solid-js/store';
import { type Card, reduceTimeline } from '../model/stream.js';
import type { DaemonClientLike } from './client.js';
import { type DataState, initialData } from './data-state.js';
import { Poller, type PollerIntervals, type PollerToast } from './poller.js';

export type { DataState } from './data-state.js';

export interface Data {
  state: DataState;
  /** The session cards of a run, memoized while its state and frames do not change. */
  timeline(runId: string): Accessor<Card[]>;
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
  const owner = getOwner();
  const timelines = new Map<string, Accessor<Card[]>>();

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
    toast: (t) => props.toast?.(t),
    log: props.log,
    open: openRun,
    now: props.now,
    intervals: props.intervals,
  });
  const closeRun = (runId: string) => {
    const i = state.open.indexOf(runId);
    if (i < 0) return;
    set('open', (o) => o.filter((id) => id !== runId));
    poller.unsubscribe(runId);
    if (state.active === runId) activate(state.open[Math.min(i, state.open.length - 1)]);
  };
  const nextTab = (direction: 1 | -1) => {
    const tabs = [undefined, ...state.open];
    const i = tabs.indexOf(state.active);
    activate(tabs[(i + direction + tabs.length) % tabs.length]);
  };
  const timeline = (runId: string): Accessor<Card[]> => {
    let memo = timelines.get(runId);
    if (!memo) {
      // a malformed frame must never take the screen down: keep the last good cards and log
      let last: Card[] = [];
      const reduce = (): Card[] => {
        try {
          last = reduceTimeline(state.states[runId], state.frames[runId] ?? []);
        } catch (e) {
          props.log?.(`timeline ${runId}: ${e instanceof Error ? e.message : String(e)}`);
        }
        return last;
      };
      const created = runWithOwner(owner, () => createMemo(reduce));
      memo = created ?? reduce;
      timelines.set(runId, memo);
    }
    return memo;
  };

  poller.start();
  if (props.single) {
    set('open', [props.single]);
    set('active', props.single);
    poller.subscribe(props.single);
  }
  onCleanup(() => poller.stop());

  const value: Data = {
    state,
    timeline,
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
