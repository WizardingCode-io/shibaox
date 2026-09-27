import type { RunState, RunStatus } from '@shibaox/core';
import type { Envelope, InboxId, SubmitRequest } from '@shibaox/daemon';
import type { ChatMessage } from '@shibaox/schemas';
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
import { money } from '../model/format.js';
import { type Card, reduceTimeline } from '../model/stream.js';
import { requestText } from '../routes/session/request.js';
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
  /** The runs of the tab that holds `runId`, oldest first. */
  threadOf(runId: string): string[];
  /** Submits the next turn in the tab of `rootId` (same org, project, workflow and adapter; the conversation so far travels as `messages`). */
  continueRun(rootId: string, text: string, o?: { event?: boolean }): Promise<string | undefined>;
  /** The model the next turns of the tab run on (`/model`). */
  setModel(rootId: string, ref: string | undefined): void;
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
    if (!state.threads[runId]) set('threads', runId, [runId]);
    for (const id of state.threads[runId] ?? [runId]) poller.subscribe(id);
    activate(runId);
  };
  const threadOf = (runId: string) => state.threads[runId] ?? [runId];
  /** The conversation turns of a tab: the runs the user talked to (dispatched runs are not turns). */
  const turnsOf = (rootId: string) =>
    threadOf(rootId).filter((id) => !state.states[id]?.parentRunId);
  const replyOf = (id: string) =>
    timeline(id)()
      .flatMap((c) => (c.kind === 'node' ? c.blocks : []))
      .flatMap((b) => (b.kind === 'text' && !b.parentId ? [b.text.trim()] : []))
      .join('\n')
      .trim();
  const continueRun = async (rootId: string, text: string, o: { event?: boolean } = {}) => {
    const turns = turnsOf(rootId);
    const previousId = turns[turns.length - 1] ?? rootId;
    const previous = state.states[previousId];
    if (!previous) return undefined;
    // the conversation so far travels as structured messages; the input is the new turn only
    const messages: ChatMessage[] = turns.flatMap((id) => {
      const st = state.states[id];
      if (!st) return [];
      const reply = replyOf(id);
      return [
        { role: 'user' as const, content: requestText(st.input) },
        ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
      ];
    });
    const model = state.models[rootId] ?? previous.model;
    const runId = await poller.submit({
      orgRoot: previous.orgRoot ?? '',
      project: previous.project ?? previous.workspace,
      workflow: previous.workflow,
      input: text,
      messages,
      ...(o.event ? { event: true } : {}),
      // with a model the daemon derives the adapter from it
      ...(model ? { model } : {}),
      adapter: previous.adapter as SubmitRequest['adapter'],
      workspace: previous.workspaceMode,
      budgetUsd: previous.budgetUsd,
    });
    if (!runId) return undefined;
    set('threads', rootId, (t = [rootId]) => [...t, runId]);
    poller.subscribe(runId);
    return runId;
  };
  /** The tab whose thread holds `runId`, when one does. */
  const rootOf = (runId: string) =>
    state.open.find((root) => (state.threads[root] ?? [root]).includes(runId));
  /** What the orchestrator is told when a run it dispatched ends. */
  const eventText = (st: RunState, status: RunStatus) => {
    const nodes = Object.entries(st.nodes);
    const summaries = nodes
      .filter(([, n]) => n.summary)
      .map(([id, n]) => `${id}: ${String(n.summary).replace(/\s+/g, ' ').slice(0, 200)}`);
    const files = timeline(st.runId)().find((c) => c.kind === 'summary');
    const parts = [
      `workflow ${st.workflow} finished: ${status}`,
      `${nodes.length} node${nodes.length === 1 ? '' : 's'}`,
      money(st.spentUsd),
      ...(files?.kind === 'summary' && files.files.length > 0
        ? [`files: ${files.files.slice(0, 20).join(', ')}`]
        : []),
      ...(st.branch ? [`branch ${st.branch}`] : []),
      ...(st.error ? [`error: ${st.error}`] : []),
      ...summaries,
    ];
    return parts.join(' · ').slice(0, 2000);
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
    for (const id of threadOf(runId)) {
      poller.unsubscribe(id);
      release(id);
    }
    set('threads', runId, undefined as never);
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

  // children whose end was already history when they joined a tab are never reported again
  const reported = new Set<string>();
  const TERMINAL = new Set<string>(['completed', 'failed', 'cancelled']);
  // a run dispatched from a conversation (`parentRunId`) joins the tab of its parent
  createEffect(() => {
    if (props.single) return;
    for (const r of state.runs) {
      if (!r.parentRunId) continue;
      const root = rootOf(r.parentRunId);
      if (!root || threadOf(root).includes(r.runId)) continue;
      if (TERMINAL.has(r.status)) reported.add(r.runId);
      set('threads', root, (t = [root]) => [...t, r.runId]);
      poller.subscribe(r.runId);
    }
  });
  // when a dispatched run ends, the conversation continues with an event for the orchestrator
  createEffect(() => {
    if (props.single) return;
    for (const root of state.open)
      for (const id of state.threads[root] ?? []) {
        const st = state.states[id];
        const status = state.ended[id];
        if (!st?.parentRunId || !status || reported.has(id)) continue;
        reported.add(id);
        void continueRun(root, eventText(st, status), { event: true });
      }
  });

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
    threadOf,
    continueRun,
    setModel: (rootId, ref) => set('models', rootId, ref as never),
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
