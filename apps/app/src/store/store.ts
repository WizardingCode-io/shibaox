import type { RunState, RunStatus } from '@wizardingcode/shibaox-core';
import type {
  Attachment,
  Envelope,
  InboxItem,
  McpAddRequest,
  OrgConfigPatch,
  RolePatch,
  RoutineInput,
  RunSummaryPlus,
  SkillAddRequest,
  SkillDiscovery,
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
import type { AppClient, RoutineDraft, RoutinePatch, RunFileContent } from '../api/client.js';
import type { AddSkillOutcome, SkillDoc } from '../screens/customize/types.js';
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
  | 'auditMarkdown'
  | 'files'
  | 'fileContent'
  | 'writeFile'
  | 'decisions'
  | 'higgsfield'
  | 'higgsfieldLogin'
  | 'fileBlob'
  | 'routines'
  | 'runRoutine'
  | 'pauseRoutine'
  | 'resumeRoutine'
  | 'removeRoutine'
  | 'addRoutine'
  | 'updateRoutine'
  | 'draftRoutine'
  | 'syncRoutines'
  | 'keys'
  | 'setKey'
  | 'unsetKey'
  | 'orgConfig'
  | 'setOrgConfig'
  | 'mcpList'
  | 'mcpTest'
  | 'projectProfile'
  | 'skills'
  | 'addSkill'
  | 'discoverSkills'
  | 'removeSkill'
  | 'roles'
  | 'setRoleLinks'
  | 'addMcp'
  | 'removeMcp'
  | 'registryConnectors'
  | 'registrySkills'
  | 'plugins'
  | 'skill'
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
  /** How often a turn waiting for the previous one looks again (ms). */
  settleEvery?: number;
  log?: (line: string) => void;
}

interface Sub {
  controller: AbortController;
  frames: Envelope[];
  cursor?: string;
  pending: Envelope[];
  flush?: ReturnType<typeof setTimeout>;
}

const SETTINGS_KEY = 'shibaox.settings';
const DEFAULT_SETTINGS: Settings = { theme: 'system' };
const FLUSH_MS = 50;
const SETTLE_LIMIT_MS = 20 * 60_000;
const isUnauthorized = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { status?: number }).status === 401;
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The app's state and the loop that feeds it: runs and the inbox by polling, the open
 * thread's runs by streaming (frames batched), and the user's actions. Turns of one thread
 * go one at a time, each after the previous one settled. Screens subscribe with
 * `useSyncExternalStore`.
 */
export class AppStore {
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly client: StoreClient;
  private readonly storage?: StorageLike;
  private readonly intervals: { fast: number; slow: number };
  private readonly settleEvery: number;
  private readonly log: (line: string) => void;
  private readonly subs = new Map<string, Sub>();
  /** Repository listings being read (`repo|path`): one request per source at a time. */
  private readonly discovering = new Map<string, Promise<SkillDiscovery | { error: string }>>();
  /** The last cursor seen per run, to resume a stream where it stopped. */
  private readonly cursors = new Map<string, string>();
  /** Dispatched runs whose end was already reported to their thread (or ended before we looked). */
  private readonly reported = new Set<string>();
  private readonly seenThreads = new Set<string>();
  /** Turns of a thread go one after the other. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private ticking?: Promise<void>;
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(o: StoreOptions) {
    this.client = o.client;
    this.storage = o.storage;
    this.intervals = { fast: o.intervals?.fast ?? 2000, slow: o.intervals?.slow ?? 5000 };
    this.settleEvery = o.settleEvery ?? 1000;
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
  /** Every thread: its root run (status and title of the root), newest activity of any member first. */
  threads(): RunSummaryPlus[] {
    const roots = new Map<string, RunSummaryPlus>();
    for (const r of this.state.runs)
      if (!r.parentRunId && (r.thread ?? r.runId) === r.runId) roots.set(r.runId, { ...r });
    for (const r of this.state.runs) {
      const root = roots.get(r.thread ?? r.runId);
      if (root && r.updatedAt > root.updatedAt) root.updatedAt = r.updatedAt;
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
  /** The live turn of a thread (running, waiting or paused), if any. */
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
    for (const t of this.refreshTimers.values()) clearTimeout(t);
    this.refreshTimers.clear();
    for (const [id] of this.subs) this.unfollow(id);
  }
  /** A round after whatever is in flight (so it sees the change), then the timer as usual. */
  async refresh(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.ticking) await this.ticking.catch(() => undefined);
    return this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const [runs, inbox, routines] = await Promise.all([
          this.client.listRuns(),
          this.client.inbox(),
          this.client.routines().catch(() => undefined),
        ]);
        this.set({
          runs,
          inbox,
          reachable: true,
          unauthorized: false,
          ...(routines ? { routines } : {}),
        });
        if (this.state.open) await this.syncThread(this.state.open);
        // the sidebar names the recent threads by their request: fetch those states once
        for (const t of this.threads().slice(0, 8))
          if (!this.state.states[t.runId]) await this.refreshState(t.runId);
      } catch (e) {
        if (isUnauthorized(e)) this.set({ unauthorized: true, reachable: true });
        else this.set({ reachable: false });
        this.log(`poll failed: ${message(e)}`);
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

  /** Streams every run of the open thread, refreshes their states, reports ended children once. */
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
    // a child is reported when its stream ended, so the event carries its whole timeline
    for (const t of this.tasksOf(rootId)) {
      const status = this.state.ended[t.runId];
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
      this.log(`state ${runId}: ${message(e)}`);
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
    const sub: Sub = {
      controller: new AbortController(),
      frames: [],
      pending: [],
      cursor: this.cursors.get(runId),
    };
    this.subs.set(runId, sub);
    const flush = () => {
      sub.flush = undefined;
      if (sub.pending.length === 0) return;
      sub.frames.push(...sub.pending);
      sub.pending = [];
      this.set((s) => ({
        cards: { ...s.cards, [runId]: reduceTimeline(s.states[runId], sub.frames) },
      }));
    };
    void (async () => {
      try {
        for await (const env of this.client.stream(runId, {
          since: sub.cursor,
          signal: sub.controller.signal,
        })) {
          sub.cursor = env.cursor;
          this.cursors.set(runId, env.cursor);
          sub.pending.push(env);
          if (env.kind === 'run' && RUN_EVENT_REFRESH.has(env.event.type)) this.refreshSoon(runId);
          if (env.kind === 'end') {
            if (sub.flush) clearTimeout(sub.flush);
            flush();
            this.set((s) => ({ ended: { ...s.ended, [runId]: env.status } }));
            await this.refreshState(runId);
            if (this.running) void this.refresh();
          } else if (!sub.flush) sub.flush = setTimeout(flush, FLUSH_MS);
        }
      } catch (e) {
        if (!sub.controller.signal.aborted) this.log(`stream ${runId}: ${message(e)}`);
      } finally {
        if (sub.flush) clearTimeout(sub.flush);
        flush();
        if (this.subs.get(runId) === sub) this.subs.delete(runId);
      }
    })();
  }
  private unfollow(runId: string): void {
    const sub = this.subs.get(runId);
    if (sub?.flush) clearTimeout(sub.flush);
    sub?.controller.abort();
    this.subs.delete(runId);
  }

  // ---- actions

  /** A message for the toast (something the user must change before sending). */
  notice(message: string): void {
    this.set({ error: message });
  }

  /** A new conversation on the default project and org; opens it. Undefined (and an error) when it could not start. */
  async newChat(text: string, attachments: Attachment[] = []): Promise<string | undefined> {
    try {
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
        ...(attachments.length > 0 ? { attachments } : {}),
      } as SubmitRequest);
      await this.refresh();
      this.openThread(runId);
      return runId;
    } catch (e) {
      this.set({ error: message(e) });
      return undefined;
    }
  }

  /** Waits until a run is over (bounded), so the next turn builds on its whole reply. */
  private async settled(runId: string): Promise<void> {
    const until = Date.now() + SETTLE_LIMIT_MS;
    while (Date.now() < until) {
      const known =
        this.state.runs.find((r) => r.runId === runId)?.status ?? this.state.states[runId]?.status;
      if (known && TERMINAL.has(known)) return;
      try {
        const st = await this.client.getRun(runId);
        this.set((s) => ({ states: { ...s.states, [runId]: st } }));
        if (TERMINAL.has(st.status)) return;
      } catch (e) {
        this.log(`settle ${runId}: ${message(e)}`);
      }
      await new Promise((r) => setTimeout(r, this.settleEvery));
    }
  }

  /**
   * The next turn of a thread: after the previous one settled, the conversation so far
   * travels as messages and the text is the new turn. Turns of a thread go one at a time.
   */
  send(
    rootId: string,
    text: string,
    o: { event?: boolean; attachments?: Attachment[]; workflow?: string } = {},
  ): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      const turns = this.turnsOf(rootId);
      const previous = turns[turns.length - 1];
      if (!previous) return undefined;
      if (!o.event) this.set((s) => ({ busy: { ...s.busy, [rootId]: true } }));
      try {
        await this.settled(previous.runId);
        const prev =
          this.state.states[previous.runId] ?? (await this.client.getRun(previous.runId));
        const reply = replyText(this.state.cards[previous.runId] ?? []);
        const messages = [
          ...conversationOf(prev.input),
          { role: 'user' as const, content: requestText(prev.input) },
          ...(reply ? [{ role: 'assistant' as const, content: reply }] : []),
        ];
        const { runId } = await this.client.submitRun({
          orgRoot: prev.orgRoot ?? previous.orgRoot ?? '',
          project: prev.project ?? previous.project ?? prev.workspace,
          // an action picked in the composer starts that workflow as a task of this conversation
          // (it lands in Tasks and its end reaches the orchestrator); a turn stays a chat turn
          workflow: o.workflow ?? previous.workflow,
          input: text,
          ...(o.workflow ? { parentRunId: previous.runId } : { messages }),
          ...(o.attachments && o.attachments.length > 0 ? { attachments: o.attachments } : {}),
          thread: rootId,
          ...(o.event ? { event: true } : {}),
          ...(() => {
            // a model picked for the thread wins; '' picked means the org's tiers (no model at all)
            const m =
              rootId in this.state.threadModels ? this.state.threadModels[rootId] : prev.model;
            return m ? { model: m } : {};
          })(),
          adapter: prev.adapter as SubmitRequest['adapter'],
          workspace: prev.workspaceMode,
          budgetUsd: prev.budgetUsd,
        } as SubmitRequest);
        await this.refresh();
        return runId;
      } catch (e) {
        this.set({ error: message(e) });
        return undefined;
      } finally {
        if (!o.event) this.set((s) => ({ busy: { ...s.busy, [rootId]: false } }));
      }
    };
    const chained = (this.chains.get(rootId) ?? Promise.resolve()).then(run, run);
    this.chains.set(rootId, chained);
    return chained;
  }

  /** Stops the live turn of a thread. */
  async stopThread(rootId: string): Promise<void> {
    const live = this.liveTurn(rootId);
    if (live) await this.cancel(live.runId);
  }
  /** Runs an action; the error becomes the toast; the result says whether it worked. */
  private async act(what: () => Promise<unknown>): Promise<boolean> {
    try {
      await what();
      if (this.running) await this.refresh();
      return true;
    } catch (e) {
      this.set({ error: message(e) });
      return false;
    }
  }
  answer(inboxId: string, approved: boolean, note?: string): Promise<boolean> {
    return this.act(() => this.client.answer(inboxId, { approved, ...(note ? { note } : {}) }));
  }
  steer(runId: string, note: string): Promise<boolean> {
    return this.act(() => this.client.steer(runId, { note }));
  }
  cancel(runId: string): Promise<boolean> {
    return this.act(() => this.client.cancel(runId));
  }
  resume(runId: string, budgetUsd?: number): Promise<boolean> {
    return this.act(() => this.client.resume(runId, budgetUsd !== undefined ? { budgetUsd } : {}));
  }
  /** The audit of a run as Markdown, fetched with the token. */
  audit(runId: string): Promise<string> {
    return this.client.auditMarkdown(runId);
  }
  /** The model the next turns of a thread run on. */
  setThreadModel(rootId: string, ref: string | undefined): void {
    // undefined = the org's tiers from now on (kept as '' so it overrides the previous turn's model)
    this.set((s) => ({ threadModels: { ...s.threadModels, [rootId]: ref ?? '' } }));
  }

  // ---- the other sections

  private async defaults(): Promise<{ project: string; orgRoot: string }> {
    const project = this.state.settings.project ?? (await this.client.projects())[0]?.path;
    if (!project) throw new Error('no project to work in: pick one in Settings');
    const orgRoot = this.state.settings.org ?? (await this.client.defaultOrg()).root;
    return { project, orgRoot };
  }
  private async load<T>(what: () => Promise<T>): Promise<T | undefined> {
    try {
      return await what();
    } catch (e) {
      if (isUnauthorized(e)) this.set({ unauthorized: true });
      else this.set({ error: message(e) });
      return undefined;
    }
  }

  /** Any workflow of the org on a request (a task, not a chat): opens its thread. */
  async runWorkflow(o: {
    workflow: string;
    text: string;
    project?: string;
    model?: string;
  }): Promise<string | undefined> {
    return this.load(async () => {
      const d = await this.defaults();
      const info = await this.client.orgInfo(d.orgRoot);
      const single = info.single.includes(o.workflow);
      const { runId } = await this.client.submitRun({
        orgRoot: d.orgRoot,
        project: o.project ?? d.project,
        workflow: o.workflow,
        input: o.text,
        adapter: info.adapter && info.adapter !== 'mock' ? info.adapter : 'direct',
        workspace: single ? 'inplace' : 'worktree',
        ...((o.model ?? this.state.settings.model)
          ? { model: o.model ?? this.state.settings.model }
          : {}),
      } as SubmitRequest);
      await this.refresh();
      this.openThread(runId);
      return runId;
    });
  }

  loadRoutines(): Promise<void> {
    return this.load(async () => {
      this.set({ routines: await this.client.routines() });
    }).then(() => undefined);
  }
  runRoutine(id: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.runRoutine(id);
      await this.loadRoutines();
    });
  }
  pauseRoutine(id: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.pauseRoutine(id);
      await this.loadRoutines();
    });
  }
  resumeRoutine(id: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.resumeRoutine(id);
      await this.loadRoutines();
    });
  }
  removeRoutine(id: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.removeRoutine(id);
      await this.loadRoutines();
    });
  }
  /** A routine on the default project and org unless given. */
  addRoutine(
    r: Omit<RoutineInput, 'orgRoot' | 'project'> & { orgRoot?: string; project?: string },
  ): Promise<boolean> {
    return this.act(async () => {
      const d = await this.defaults();
      await this.client.addRoutine({
        orgRoot: r.orgRoot ?? d.orgRoot,
        project: r.project ?? d.project,
        ...r,
      } as RoutineInput);
      await this.loadRoutines();
    });
  }
  updateRoutine(id: string, patch: RoutinePatch): Promise<boolean> {
    return this.act(async () => {
      await this.client.updateRoutine(id, patch);
      await this.loadRoutines();
    });
  }
  /** "Create with Shibaox": a sentence into a draft, or undefined with the error as a toast. */
  async draftRoutine(text: string): Promise<RoutineDraft | undefined> {
    try {
      const d = await this.defaults();
      return await this.client.draftRoutine({ text, orgRoot: d.orgRoot, project: d.project });
    } catch (e) {
      if (isUnauthorized(e)) this.set({ unauthorized: true });
      else this.set({ error: message(e) });
      return undefined;
    }
  }
  loadProjects(): Promise<void> {
    return this.load(async () => {
      this.set({ projects: await this.client.projects() });
    }).then(() => undefined);
  }
  syncRoutines(): Promise<boolean> {
    return this.act(async () => {
      const d = await this.defaults();
      await this.client.syncRoutines(d.orgRoot);
      await this.loadRoutines();
    });
  }

  /** Starts the Higgsfield browser login on the daemon's machine, then reads the status again. */
  higgsfieldLogin(): Promise<{ url?: string; output?: string } | undefined> {
    return (async () => {
      let r: { started: boolean; url?: string; output?: string } | undefined;
      const ok = await this.act(async () => {
        r = await this.client.higgsfieldLogin();
      });
      if (!ok) return undefined;
      // the login finishes in the browser: read the status again for a while
      void (async () => {
        for (let i = 0; i < 40; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          await this.refreshHiggsfield();
          if (this.state.customize?.higgsfield?.loggedIn) break;
        }
      })();
      return r;
    })();
  }

  loadSkills(): Promise<void> {
    return this.load(async () => {
      const d = await this.defaults();
      const info = await this.client.orgInfo(d.orgRoot);
      this.set({
        skills: {
          org: d.orgRoot,
          workflows: info.workflows.map((name) => ({
            name,
            description: info.descriptions?.[name] ?? '',
            conversation: info.single.includes(name),
          })),
          catalog: info.catalog ?? [],
        },
      });
    }).then(() => undefined);
  }

  loadMemory(): Promise<void> {
    return this.load(async () => {
      const d = await this.defaults();
      const [profile, org] = await Promise.all([
        this.client.projectProfile(d.project, d.orgRoot).catch((e: unknown) => {
          this.set((s) => ({ memory: { ...s.memory, error: message(e) } }));
          return undefined;
        }),
        this.client.orgConfig(d.orgRoot).catch(() => undefined),
      ]);
      this.set((s) => ({
        memory: {
          ...s.memory,
          project: d.project,
          profile: profile ?? undefined,
          org: org ?? undefined,
        },
      }));
    }).then(() => undefined);
  }

  /** One file a run produced, for the file sheet. */
  loadFile(runId: string, path: string): Promise<RunFileContent> {
    return this.client.fileContent(runId, path);
  }

  /** Saves a file of a run through the browser's download (a Blob URL, never the token). */
  async downloadFile(runId: string, path: string): Promise<boolean> {
    try {
      saveBlob(await this.client.fileBlob(runId, path), path.split('/').pop() ?? 'file');
      return true;
    } catch (e) {
      this.set({ error: message(e) });
      return false;
    }
  }

  /** The whole file as a Blob (what the desktop opens or saves when the preview is cut). */
  loadWhole(runId: string, path: string): Promise<Blob> {
    return this.client.fileBlob(runId, path);
  }

  /** Saves text the model wrote (a code block) as a file through the browser's download. */
  downloadText(name: string, content: string): void {
    saveBlob(new Blob([content], { type: 'text/plain;charset=utf-8' }), name);
  }

  /** Writes a code block into the run's workspace (the path as the daemon spells it); the daemon's error is the thrown message. */
  async writeFile(runId: string, path: string, content: string): Promise<string> {
    try {
      return (await this.client.writeFile(runId, path, content)).path;
    } catch (e) {
      throw new Error(message(e));
    }
  }

  loadIntegrations(): Promise<void> {
    return this.load(async () => {
      const d = await this.defaults();
      const failed: string[] = [];
      const part = <T>(what: Promise<T>, fallback: T): Promise<T> =>
        what.catch((e: unknown) => {
          if (isUnauthorized(e)) this.set({ unauthorized: true });
          failed.push(message(e));
          return fallback;
        });
      const [mcp, models, keys, decisions, higgsfield, config] = await Promise.all([
        part(this.client.mcpList(d.orgRoot), [] as Awaited<ReturnType<StoreClient['mcpList']>>),
        part(this.client.models(), [] as Awaited<ReturnType<StoreClient['models']>>),
        part(this.client.keys(), [] as Awaited<ReturnType<StoreClient['keys']>>),
        part(this.client.decisions(), undefined),
        part(this.client.higgsfield(), undefined),
        part(
          this.client.orgConfig(d.orgRoot),
          undefined as Awaited<ReturnType<StoreClient['orgConfig']>> | undefined,
        ),
      ]);
      if (failed.length) this.set({ error: failed[0] });
      this.set({
        integrations: {
          org: d.orgRoot,
          mcp,
          models,
          keys,
          config: config ?? undefined,
          decisions: decisions ?? undefined,
          higgsfield: higgsfield ?? undefined,
        },
      });
    }).then(() => undefined);
  }
  // ---- Customize

  /** The org Customize edits: the one in Settings, else the daemon's default. */
  private async orgRoot(): Promise<string> {
    return this.state.settings.org ?? (await this.client.defaultOrg()).root;
  }

  /**
   * Everything Customize shows, fetched in parallel: a part the daemon cannot answer stays
   * empty and its message becomes the toast; the rest still loads.
   */
  loadCustomize(): Promise<void> {
    return this.load(async () => {
      const org = await this.orgRoot();
      const failed: string[] = [];
      const part = <T>(what: Promise<T>, fallback: T): Promise<T> =>
        what.catch((e: unknown) => {
          if (isUnauthorized(e)) this.set({ unauthorized: true });
          failed.push(message(e));
          return fallback;
        });
      const c = this.client;
      const [
        skills,
        roles,
        mcp,
        models,
        keys,
        config,
        decisions,
        higgsfield,
        plugins,
        connectors,
        sources,
        info,
      ] = await Promise.all([
        part(c.skills(org), [] as Awaited<ReturnType<StoreClient['skills']>>),
        part(c.roles(org), [] as Awaited<ReturnType<StoreClient['roles']>>),
        part(c.mcpList(org), [] as Awaited<ReturnType<StoreClient['mcpList']>>),
        part(c.models(), [] as Awaited<ReturnType<StoreClient['models']>>),
        part(c.keys(), [] as Awaited<ReturnType<StoreClient['keys']>>),
        part(
          c.orgConfig(org),
          undefined as Awaited<ReturnType<StoreClient['orgConfig']>> | undefined,
        ),
        part(c.decisions(), undefined),
        part(c.higgsfield(), undefined),
        part(c.plugins(), [] as Awaited<ReturnType<StoreClient['plugins']>>),
        part(c.registryConnectors(), [] as Awaited<ReturnType<StoreClient['registryConnectors']>>),
        part(c.registrySkills(), [] as Awaited<ReturnType<StoreClient['registrySkills']>>),
        part(c.orgInfo(org), undefined as Awaited<ReturnType<StoreClient['orgInfo']>> | undefined),
      ]);
      if (failed.length) this.set({ error: failed[0] });
      const workflows = (info?.workflows ?? []).map((name) => ({
        name,
        description: info?.descriptions?.[name] ?? '',
        conversation: info?.single.includes(name) ?? false,
      }));
      this.set({
        customize: {
          org,
          skills,
          roles,
          mcp,
          models,
          keys,
          config: config ?? undefined,
          decisions: decisions ?? undefined,
          higgsfield: higgsfield ?? undefined,
          plugins,
          registry: { connectors, skills: sources },
          workflows,
        },
        // the thread's and the routine dialog's lists ride along
        integrations: {
          org,
          mcp,
          models,
          keys,
          config: config ?? undefined,
          decisions: decisions ?? undefined,
          higgsfield: higgsfield ?? undefined,
        },
        ...(info ? { skills: { org, workflows, catalog: info.catalog ?? [] } } : {}),
      });
    }).then(() => undefined);
  }

  /** The Higgsfield status and the plugins again (after a login in the browser). */
  async refreshHiggsfield(): Promise<void> {
    const [higgsfield, plugins] = await Promise.all([
      this.client.higgsfield().catch(() => undefined),
      this.client.plugins().catch(() => undefined),
    ]);
    this.set((s) =>
      s.customize
        ? {
            customize: {
              ...s.customize,
              ...(higgsfield ? { higgsfield } : {}),
              ...(plugins ? { plugins } : {}),
            },
          }
        : {},
    );
  }

  /**
   * What a repository offers; the listing (or why it failed) is kept for Discover. A source
   * already being read is not asked twice: the call joins the pending one.
   */
  discoverSkills(repo: string, path?: string): Promise<SkillDiscovery | { error: string }> {
    const key = path ? `${repo}|${path}` : repo;
    const pending = this.discovering.get(key);
    if (pending) return pending;
    const p = (async () => {
      let r: SkillDiscovery | { error: string };
      try {
        r = await this.client.discoverSkills(repo, path);
      } catch (e) {
        if (isUnauthorized(e)) this.set({ unauthorized: true });
        r = { error: message(e) };
      }
      this.set((s) => ({ discovered: { ...s.discovered, [key]: r } }));
      return r;
    })().finally(() => this.discovering.delete(key));
    this.discovering.set(key, p);
    return p;
  }
  /** Whether a source's listing is being read. */
  isDiscovering(repo: string, path?: string): boolean {
    return this.discovering.has(path ? `${repo}|${path}` : repo);
  }
  /** One skill with its SKILL.md (undefined: the toast says why). */
  loadSkill(id: string): Promise<SkillDoc | undefined> {
    return this.load(async () => this.client.skill(await this.orgRoot(), id));
  }
  /** Installs or writes skills; the result says what was added and skipped (undefined: the toast says why). */
  async addSkill(req: SkillAddRequest): Promise<AddSkillOutcome | undefined> {
    let r: AddSkillOutcome | undefined;
    const ok = await this.act(async () => {
      r = await this.client.addSkill(await this.orgRoot(), req);
      await this.loadCustomize();
    });
    return ok ? r : undefined;
  }
  /**
   * Removes a skill. While roles still list it (a 409 naming them), the answer is those roles
   * (no toast): the screen asks whether to detach first.
   */
  async removeSkill(id: string, detach: boolean): Promise<boolean | { inUse: string[] }> {
    let inUse: string[] | undefined;
    const ok = await this.act(async () => {
      try {
        await this.client.removeSkill(await this.orgRoot(), id, detach);
      } catch (e) {
        const roles = (e as { status?: number; details?: { roles?: unknown } }).details?.roles;
        if ((e as { status?: number }).status === 409 && Array.isArray(roles)) {
          inUse = roles.map(String);
          return;
        }
        throw e;
      }
      await this.loadCustomize();
    });
    return inUse ? { inUse } : ok;
  }
  /** Replaces the lists of each role that changed, then reads the org again. */
  setRoleLinks(changes: { id: string; links: RolePatch }[]): Promise<boolean> {
    return this.act(async () => {
      const org = await this.orgRoot();
      for (const ch of changes) await this.client.setRoleLinks(org, ch.id, ch.links);
      await this.loadCustomize();
    });
  }
  addMcp(req: McpAddRequest): Promise<boolean> {
    return this.act(async () => {
      await this.client.addMcp(await this.orgRoot(), req);
      await this.loadCustomize();
    });
  }
  removeMcp(id: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.removeMcp(await this.orgRoot(), id);
      await this.loadCustomize();
    });
  }

  setKey(name: string, value: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.setKey(name, value);
      await this.loadCustomize();
    });
  }
  unsetKey(name: string): Promise<boolean> {
    return this.act(async () => {
      await this.client.unsetKey(name);
      await this.loadCustomize();
    });
  }
  saveOrgConfig(patch: OrgConfigPatch): Promise<boolean> {
    return this.act(async () => {
      const org = await this.orgRoot();
      await this.client.setOrgConfig(org, patch);
      await this.loadCustomize();
    });
  }
  /** Starts a catalog server on the daemon and lists its tools (undefined and an error when it could not). */
  testMcp(
    id: string,
  ): Promise<
    { ok: boolean; tools?: { name: string; description: string }[]; error?: string } | undefined
  > {
    return this.load(async () => {
      const org = await this.orgRoot();
      return this.client.mcpTest(id, org);
    });
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

/** A Blob through an anchor download (never the token in a URL). */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
