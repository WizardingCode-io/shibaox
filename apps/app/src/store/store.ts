import type { RunState, RunStatus } from '@wizardingcode/shibaox-core';
import type {
  Envelope,
  InboxItem,
  RunSummaryPlus,
  SubmitRequest,
} from '@wizardingcode/shibaox-daemon';
import {
  conversationOf,
  eventTurnText,
  RUN_EVENT_REFRESH,
  reduceTimeline,
  replyText,
  requestText,
  type ThreadView,
  threadView,
} from '@wizardingcode/shibaox-view';
import type { AppClient } from '../api/client.js';
import { type AppState, initialState, type Settings, TERMINAL } from './state.js';

/** The part of AppClient the store uses (a fake in tests). */
export type StoreClient = Pick<
  AppClient,
  | 'health'
  | 'listRuns'
  | 'getRun'
  | 'inbox'
  | 'submitRun'
  | 'answer'
  | 'steer'
  | 'cancel'
  | 'resume'
  | 'models'
  | 'projects'
  | 'defaultOrg'
  | 'orgInfo'
  | 'stream'
>;

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface StoreOptions {
  client: StoreClient;
  storage?: StorageLike;
  /** Poll intervals in ms: `fast` while the open thread is live, `slow` otherwise. */
  intervals?: { fast?: number; slow?: number };
  log?: (line: string) => void;
}

interface Sub {
  controller: AbortController;
  frames: Envelope[];
  cursor?: string;
}

const SETTINGS_KEY = 'shibaox.settings';
const DEFAULT_SETTINGS: Settings = { theme: 'system' };

/**
 * The app's state and the loop that feeds it: runs and the inbox by polling, the open
 * thread's runs by streaming, and the user's actions. Screens subscribe with
 * `useSyncExternalStore`.
 */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly client: StoreClient;
  private readonly storage?: StorageLike;
  private readonly intervals: { fast: number; slow: number };
  private readonly log: (line: string) => void;
  private readonly subs = new Map<string, Sub>();
  /** Dispatched runs whose end was already reported to their thread (or ended before we looked). */
  private readonly reported = new Set<string>();
  private readonly seenThreads = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private ticking?: Promise<void>;
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(o: StoreOptions) {
    this.client = o.client;
    this.storage = o.storage;
    this.intervals = { fast: o.intervals?.fast ?? 2000, slow: o.intervals?.slow ?? 5000 };
    this.log = o.log ?? (() => undefined);
    this.state = initialState(this.loadSettings());
  }

  // ---- the store contract

  get(): AppState {
    return this.state;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  // ---- selectors

  /** The conversation turns of a thread (runs the user talked to), oldest first. */
  turnsOf(rootId: string): RunSummaryPlus[] {
    return this.state.runs
      .filter((r) => (r.thread ?? r.runId) === rootId && !r.parentRunId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** The runs dispatched inside a thread, oldest first. */
  tasksOf(rootId: string): RunSummaryPlus[] {
    return this.state.runs
      .filter((r) => (r.thread ?? r.runId) === rootId && r.parentRunId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  /** Every thread (root runs), newest activity first. */
  threads(): RunSummaryPlus[] {
    const roots = new Map<string, RunSummaryPlus>();
    for (const r of this.state.runs) {
      const root = r.thread ?? r.runId;
      const cur = roots.get(root);
      if (!cur || r.updatedAt > cur.updatedAt)
        roots.set(root, {
          ...(this.state.runs.find((x) => x.runId === root) ?? r),
          updatedAt: r.updatedAt,
          status: cur && r.parentRunId ? cur.status : r.status,
        });
    }
    return [...roots.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  /** The thread as the screen shows it, or undefined before its turns are known. */
  thread(rootId: string): ThreadView | undefined {
    const turns = this.turnsOf(rootId);
    if (turns.length === 0) return undefined;
    return threadView(
      turns.map((t) => ({
        state: this.state.states[t.runId] ?? this.placeholderState(t),
        cards: this.state.cards[t.runId] ?? [],
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
    );
  }
  private placeholderState(t: RunSummaryPlus): RunState {
    return {
      runId: t.runId,
      workflow: t.workflow,
      status: t.status,
      input: {},
      workspace: '',
      nodes: {},
      pendingApprovals: [],
      pendingHumans: [],
      spentUsd: t.spentUsd,
    } as unknown as RunState;
  }
  /** The live turn of a thread (running or waiting), if any. */
  liveTurn(rootId: string): RunSummaryPlus | undefined {
    return this.turnsOf(rootId)
      .reverse()
      .find((t) => !TERMINAL.has(t.status));
  }

  // ---- the loop

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.tick();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    for (const [id] of this.subs) this.unfollow(id);
  }
  /** One round now (after an action), then the timer as usual. */
  refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    return this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const [runs, inbox] = await Promise.all([this.client.listRuns(), this.client.inbox()]);
        this.set({ runs, inbox, reachable: true });
        if (this.state.open) await this.syncThread(this.state.open);
        // the sidebar names the recent threads by their request: fetch those states once
        for (const t of this.threads().slice(0, 8))
          if (!this.state.states[t.runId]) await this.refreshState(t.runId);
      } catch (e) {
        this.set({ reachable: false });
        this.log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    try {
      await this.ticking;
    } finally {
      this.ticking = undefined;
      if (this.running) {
        const live = this.state.open ? this.liveTurn(this.state.open) !== undefined : false;
        this.timer = setTimeout(
          () => void this.tick(),
          live ? this.intervals.fast : this.intervals.slow,
        );
      }
    }
  }

  openThread(rootId: string | undefined): void {
    if (this.state.open === rootId) return;
    for (const [id] of this.subs) this.unfollow(id);
    this.set({ open: rootId });
    if (rootId) void this.refresh();
  }

  /** Streams every run of the open thread once, refreshes their states, reports ended children. */
  private async syncThread(rootId: string): Promise<void> {
    const members = [...this.turnsOf(rootId), ...this.tasksOf(rootId)];
    const first = !this.seenThreads.has(rootId);
    this.seenThreads.add(rootId);
    for (const m of members) {
      // children that were already over when we first looked are not news for the orchestrator
      if (first && m.parentRunId && TERMINAL.has(m.status)) this.reported.add(m.runId);
      if (!this.state.states[m.runId] || this.state.states[m.runId]?.status !== m.status)
        await this.refreshState(m.runId);
      if (!this.subs.has(m.runId) && !this.state.ended[m.runId]) this.follow(m.runId);
    }
    for (const t of this.tasksOf(rootId)) {
      const status = this.state.ended[t.runId] ?? (TERMINAL.has(t.status) ? t.status : undefined);
      if (!status || this.reported.has(t.runId)) continue;
      this.reported.add(t.runId);
      const st = this.state.states[t.runId];
      if (st)
        void this.send(rootId, eventTurnText(st, status, this.state.cards[t.runId] ?? []), {
          event: true,
        });
    }
  }

  private async refreshState(runId: string): Promise<void> {
    try {
      const st = await this.client.getRun(runId);
      this.set((s) => ({ states: { ...s.states, [runId]: st } }));
    } catch (e) {
      this.log(`state ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  private refreshSoon(runId: string): void {
    if (this.refreshTimers.has(runId)) return;
    this.refreshTimers.set(
      runId,
      setTimeout(() => {
        this.refreshTimers.delete(runId);
        void this.refreshState(runId);
      }, 150),
    );
  }

  private follow(runId: string): void {
    const sub: Sub = { controller: new AbortController(), frames: [] };
    this.subs.set(runId, sub);
    void (async () => {
      try {
        for await (const env of this.client.stream(runId, { signal: sub.controller.signal })) {
          sub.frames.push(env);
          sub.cursor = env.cursor;
          if (env.kind === 'run' && RUN_EVENT_REFRESH.has(env.event.type)) this.refreshSoon(runId);
          this.set((s) => ({
            cards: { ...s.cards, [runId]: reduceTimeline(s.states[runId], sub.frames) },
            ...(env.kind === 'end' ? { ended: { ...s.ended, [runId]: env.status } } : {}),
          }));
          if (env.kind === 'end') {
            await this.refreshState(runId);
            if (this.running) void this.refresh();
          }
        }
      } catch (e) {
        if (!sub.controller.signal.aborted)
          this.log(`stream ${runId}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (this.subs.get(runId) === sub) this.subs.delete(runId);
      }
    })();
  }
  private unfollow(runId: string): void {
    this.subs.get(runId)?.controller.abort();
    this.subs.delete(runId);
  }

  // ---- actions

  /** A new conversation on the default project and org; returns the thread id and opens it. */
  async newChat(text: string): Promise<string> {
    const project = this.state.settings.project ?? (await this.client.projects())[0]?.path;
    if (!project) throw new Error('no project to start in: pick one in Settings');
    const orgRoot = this.state.settings.org ?? (await this.client.defaultOrg()).root;
    const info = await this.client.orgInfo(orgRoot);
    const workflow = info.single[0] ?? 'chat';
    const { runId } = await this.client.submitRun({
      orgRoot,
      project,
      workflow,
      input: text,
      adapter: info.adapter && info.adapter !== 'mock' ? info.adapter : 'direct',
      workspace: 'inplace',
      ...(this.state.settings.model ? { model: this.state.settings.model } : {}),
    } as SubmitRequest);
    await this.refresh();
    this.openThread(runId);
    return runId;
  }

  /** The next turn of a thread: the conversation so far travels as messages, the text is the new turn. */
  async send(
    rootId: string,
    text: string,
    o: { event?: boolean } = {},
  ): Promise<string | undefined> {
    const turns = this.turnsOf(rootId);
    const previous = turns[turns.length - 1];
    if (!previous) return undefined;
    const prev = this.state.states[previous.runId] ?? (await this.client.getRun(previous.runId));
    const reply = replyText(this.state.cards[previous.runId] ?? []);
    const messages = [
      ...conversationOf(prev.input),
      { role: 'user' as const, content: requestText(prev.input) },
      ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
    ];
    this.set((s) => ({ busy: { ...s.busy, [rootId]: true } }));
    try {
      const { runId } = await this.client.submitRun({
        orgRoot: prev.orgRoot ?? previous.orgRoot ?? '',
        project: prev.project ?? previous.project ?? prev.workspace,
        workflow: previous.workflow,
        input: text,
        messages,
        thread: rootId,
        ...(o.event ? { event: true } : {}),
        ...(prev.model ? { model: prev.model } : {}),
        adapter: prev.adapter as SubmitRequest['adapter'],
        workspace: prev.workspaceMode,
        budgetUsd: prev.budgetUsd,
      } as SubmitRequest);
      await this.refresh();
      return runId;
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      this.set((s) => ({ busy: { ...s.busy, [rootId]: false } }));
    }
  }

  /** Stops the live turn of a thread. */
  async stopThread(rootId: string): Promise<void> {
    const live = this.liveTurn(rootId);
    if (live) await this.cancel(live.runId);
  }
  async answer(inboxId: string, approved: boolean, note?: string): Promise<void> {
    await this.client.answer(inboxId, { approved, ...(note ? { note } : {}) });
    if (this.running) await this.refresh();
  }
  async steer(runId: string, note: string): Promise<void> {
    await this.client.steer(runId, { note });
    if (this.running) await this.refresh();
  }
  async cancel(runId: string): Promise<void> {
    await this.client.cancel(runId);
    if (this.running) await this.refresh();
  }
  async resume(runId: string): Promise<void> {
    await this.client.resume(runId);
    if (this.running) await this.refresh();
  }
  clearError(): void {
    this.set({ error: undefined });
  }

  // ---- settings

  setSettings(patch: Partial<Settings>): void {
    const settings = { ...this.state.settings, ...patch };
    this.set({ settings });
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // storage may be unavailable (private mode): the choice lives for the session
    }
  }
  private loadSettings(): Settings {
    try {
      const raw = this.storage?.getItem(SETTINGS_KEY);
      return raw
        ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
        : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }
}

export type { InboxItem, RunStatus };
