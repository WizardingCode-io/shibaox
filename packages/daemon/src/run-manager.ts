import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import {
  compactConversation,
  type EventStore,
  isTerminal,
  type MockScript,
  RunEngine,
  type RunState,
  type RunStatus,
  type RunSummary,
  replay,
  ScriptedDecider,
  type StoredEvent,
} from '@shibaox/core';
import { type Graphify, MemoryNotes } from '@shibaox/memory';
import type { ProviderEntry } from '@shibaox/providers';
import { type ChatMessage, loadOrg, type Org, type Workflow } from '@shibaox/schemas';
import { createRunWorkspace, type WorkspaceMode } from '@shibaox/workspace';
import type { DaemonConfig } from './config.js';
import type { InboxAnswer, InboxItem, InboxService } from './inbox.js';
import { type DiffResult, diffWorkspace, worktreeBase } from './runs/diff.js';
import { type GraphMode, prepareGraph } from './runs/graph.js';
import { finishRun, vaultDir } from './runs/notes.js';
import { memoryTools, orchestrationTools, toolsForRole } from './runs/orchestration.js';
import { profileFor } from './runs/profile.js';
import type { Summarizer } from './runs/summarize.js';
import {
  assertProjectDir,
  gitPrefix,
  projectName,
  projectOf,
  workspaceMode,
  worktreeOf,
} from './runs/workspace.js';
import {
  type AdapterId,
  adapterForModel,
  buildRuntime,
  effectiveAdapter,
  type GraphWiring,
  isAdapterId,
  type RuntimeOptions,
  registryFor,
} from './runtime.js';
import { RuntimeBuffer, type RuntimeEnvelope } from './runtime-buffer.js';

export interface SubmitRequest {
  orgRoot: string;
  project: string;
  workflow: string;
  input: string;
  adapter?: AdapterId;
  workspace?: WorkspaceMode;
  budgetUsd?: number;
  graph?: GraphMode;
  /** The conversation so far (the orchestrator's chat); `input` is the new turn. */
  messages?: ChatMessage[];
  /** The run this one is dispatched from (`start_workflow`). */
  parentRunId?: string;
  /** A turn shibaox submits itself (a dispatched run ended): rendered quietly, never re-dispatches. */
  event?: boolean;
  /** Who asked (`schedule:<id>`, `telegram:<chatId>`): the run reports back there when it ends. */
  origin?: string;
  /** A model ref (`provider/model`) for every task of the run; the adapter follows from it. */
  model?: string;
}

/** A conversation carried into a run is compacted beyond this (estimated tokens). */
export const CONVERSATION_TOKENS = 32_000;

export interface RunManagerOptions {
  store: EventStore;
  inbox: InboxService;
  config: Pick<DaemonConfig, 'max_concurrent_runs'>;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  queryFn?: QueryFn;
  graphify?: Graphify;
  extraProviders?: ProviderEntry[];
  /** Vault directory; overrides `vault:` in org.yaml. */
  vault?: string;
  mockScript?: MockScript;
  now?: () => string;
  /**
   * Awaited before a run starts: the daemon's model discovery, so the run's registry costs
   * and measures with what the providers said (bounded by the probe timeouts; errors ignored).
   */
  ready?: () => Promise<unknown>;
  /**
   * Picks the summariser for a conversation that outgrew `conversationTokens` (the org's
   * cheap tier, or the run's model); none when no model is callable: the turns are then cut
   * to lines, under a cap three times larger (long windows can afford it).
   */
  summarizer?: (org: Org, model: string | undefined) => Summarizer | undefined;
  /** Tokens (estimated) a conversation may carry into a run before it is compacted. */
  conversationTokens?: number;
  /** A run with an `origin` ended: the daemon reports it where it was asked for. */
  onFinished?: (
    state: RunState,
    events: StoredEvent[],
    workflow: Workflow | undefined,
    notePath?: string,
  ) => void;
}

export interface RunSummaryPlus extends RunSummary {
  project?: string;
  orgRoot?: string;
  spentUsd: number;
  parentRunId?: string;
  origin?: string;
}

interface Prepared {
  engine: RunEngine;
  org: Org;
  adapter: AdapterId;
}

interface Pending {
  runId: string;
  action: 'run' | 'resume';
  budgetUsd?: number;
  settle: { resolve: (s: RunState) => void; reject: (e: unknown) => void }[];
}

const ORG_DEFAULT_CONCURRENCY = 2;

/**
 * Executes runs inside the daemon: a FIFO queue bounded by the daemon and org concurrency
 * limits, one `RunEngine` per active run (rebuilt from the event log after a restart),
 * runtime events streamed to subscribers and kept in a per-run buffer, vault notes when a
 * run ends, and the inbox hooks that continue a run once a human or an approval answers.
 */
export class RunManager {
  private readonly live = new Map<string, { orgRoot: string; engine: RunEngine; token: object }>();
  private readonly queue: Pending[] = [];
  private readonly prepared = new Map<string, Prepared>();
  private readonly buffer = new RuntimeBuffer();
  private readonly listeners = new Set<(e: RuntimeEnvelope) => void>();
  private readonly starting = new Set<string>();
  private readonly now: () => string;
  private stopping = false;
  private pumping = false;

  constructor(private readonly opts: RunManagerOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Validates, creates the workspace, emits `RunCreated` (queued) and schedules the run. */
  async submit(
    req: SubmitRequest,
  ): Promise<{ runId: string; warnings: string[]; messages?: ChatMessage[] }> {
    if (this.stopping) throw new Error('the daemon is stopping');
    const orgRoot = resolve(req.orgRoot);
    const org = loadOrg(orgRoot);
    const project = resolve(req.project);
    assertProjectDir(project);
    const wf = org.workflows[req.workflow];
    if (!wf) throw new Error(`workflow "${req.workflow}" is not defined in the org`);
    const warnings: string[] = [];
    // an explicit mock adapter never calls a model: a chosen model is set aside with a warning
    const model = req.adapter === 'mock' ? undefined : req.model;
    if (req.model && !model) warnings.push(`adapter mock: the model ${req.model} is not used`);
    const adapter = model
      ? adapterForModel(model, registryFor(this.opts.env ?? process.env, this.opts.extraProviders))
      : effectiveAdapter(req.adapter, org);
    if (model) await this.assertListed(model);
    const mode = await workspaceMode(project, req.workspace, (l) => warnings.push(l));
    const budgetUsd = req.budgetUsd ?? org.org.budgets.per_run_usd;
    const runId = randomUUID();
    const graph = await this.graphFor({
      project,
      org,
      workflow: wf,
      request: req.input,
      adapter,
      mode: req.graph,
    });
    // builds (and checks) the runtime before the worktree exists
    const engine = this.buildEngine(org, {
      adapter,
      workflow: wf,
      budgetUsd,
      graph,
      runId,
      project,
      workspaceMode: mode,
      origin: req.origin,
      model,
      warn: (w) => warnings.push(w),
    });
    const ws = await createRunWorkspace({ project, runId, mode });
    const workspace = ws.mode === 'worktree' ? join(ws.path, await gitPrefix(project)) : ws.path;
    const raw = req.messages?.filter((m) => m && typeof m.content === 'string') ?? [];
    // a conversation that outgrew its cap carries a summary of its oldest turns instead
    const summarize = raw.length > 0 ? this.opts.summarizer?.(org, model) : undefined;
    const cap = this.opts.conversationTokens ?? CONVERSATION_TOKENS;
    const messages = await compactConversation(raw, {
      maxTokens: summarize ? cap : cap * 3,
      summarize: summarize ?? (() => Promise.reject(new Error('no summariser'))),
    });
    const compacted = messages !== raw;
    if (compacted) warnings.push('conversation compacted: the oldest turns are summarised');
    await engine.create({
      workflow: req.workflow,
      input: {
        spec: req.input,
        ...(messages.length > 0 ? { messages } : {}),
        ...(req.event ? { event: true } : {}),
      },
      workspace,
      budgetUsd,
      adapter,
      workspaceMode: ws.mode,
      project,
      branch: ws.branch,
      baseBranch: ws.baseBranch,
      orgRoot,
      parentRunId: req.parentRunId,
      origin: req.origin,
      model,
    });
    this.prepared.set(runId, { engine, org, adapter });
    this.enqueue({ runId, action: 'run', settle: [] });
    return { runId, warnings, ...(compacted ? { messages } : {}) };
  }

  /** Recovers the runs left by a previous daemon process. */
  async start(): Promise<void> {
    for (const run of await this.opts.store.listRuns()) {
      try {
        if (run.status === 'queued') this.enqueue({ runId: run.runId, action: 'run', settle: [] });
        else if (run.status === 'running')
          this.enqueue({ runId: run.runId, action: 'resume', settle: [] });
        else if (run.status === 'waiting_approval') {
          // the task process is gone: its nodes become re-runnable, keeping their session ids
          await this.lightEngine().suspend(run.runId);
        }
      } catch (e) {
        // one broken run (org directory gone, unreadable log) never stops the daemon
        this.opts.log(
          `[daemon] run ${run.runId} not recovered: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** Waits for active runs (up to `graceMs`), then cancels what is left. */
  async stop(o: { force?: boolean; graceMs?: number } = {}): Promise<void> {
    this.stopping = true;
    this.queue.splice(0);
    const grace = o.force ? 0 : (o.graceMs ?? 60_000);
    const deadline = Date.now() + grace;
    while (this.live.size > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    for (const [runId, a] of [...this.live]) {
      if (o.force) await a.engine.cancel(runId, 'daemon stopped').catch(() => undefined);
      // past the grace period the task is aborted but the log stays `running`: the next
      // daemon start recovers it (interrupted nodes re-run)
      else a.engine.abort(runId, 'daemon stopped');
      this.live.delete(runId);
    }
    this.prepared.clear();
  }

  async cancel(runId: string): Promise<RunState> {
    const a = this.live.get(runId);
    const idx = this.queue.findIndex((p) => p.runId === runId);
    if (idx >= 0) this.queue.splice(idx, 1);
    this.prepared.delete(runId);
    const engine = a?.engine ?? this.lightEngine();
    const state = await engine.cancel(runId, 'cancelled by the user');
    if (a) {
      // a task that ignores the abort signal must not hold the slot
      this.live.delete(runId);
      this.pump();
    }
    return state;
  }

  /** Continues a waiting/paused/interrupted run; resolves when it leaves the engine loop again. */
  async resume(runId: string, o: { budgetUsd?: number } = {}): Promise<RunState> {
    const state = await this.state(runId);
    if (isTerminal(state.status)) return state;
    if (this.live.has(runId)) throw new Error(`run ${runId} is already running`);
    const wt = worktreeOf(state);
    if (wt && !existsSync(wt.path))
      throw new Error(
        `cannot resume run ${runId}: its worktree ${wt.path} no longer exists (see: shibaox worktree list --project ${wt.project})`,
      );
    if (state.pendingApprovals.length > 0) {
      const p = state.pendingApprovals[0];
      throw new Error(
        `run ${runId} is waiting for an approval: answer the pending approval first (shibaox approve approval:${p?.approvalId})`,
      );
    }
    if (
      state.status === 'paused_budget' &&
      (o.budgetUsd === undefined || !(o.budgetUsd > state.spentUsd))
    )
      throw new Error(
        `run ${runId} is paused on budget: pass a budgetUsd higher than ${state.spentUsd}`,
      );
    return new Promise<RunState>((resolve, reject) => {
      this.enqueue({
        runId,
        action: state.status === 'queued' ? 'run' : 'resume',
        budgetUsd: o.budgetUsd,
        settle: [{ resolve, reject }],
      });
    });
  }

  async state(runId: string): Promise<RunState> {
    const events = await this.opts.store.read(runId);
    if (events.length === 0) throw new Error(`run ${runId} not found`);
    return replay(events);
  }

  /** The run's checkout diff against HEAD; `undefined` when the workspace directory is gone. */
  async diff(runId: string): Promise<DiffResult | undefined> {
    const state = await this.state(runId);
    const project = state.workspaceMode === 'worktree' ? projectOf(state) : undefined;
    const base =
      project && project !== state.workspace && existsSync(state.workspace)
        ? await worktreeBase(state.workspace, project).catch(() => undefined)
        : undefined;
    return diffWorkspace(state.workspace, { base });
  }

  async list(filter: { status?: RunStatus; orgRoot?: string } = {}): Promise<RunSummaryPlus[]> {
    const out: RunSummaryPlus[] = [];
    for (const run of await this.opts.store.listRuns()) {
      if (filter.status && run.status !== filter.status) continue;
      const state = replay(await this.opts.store.read(run.runId));
      if (filter.orgRoot && state.orgRoot !== resolve(filter.orgRoot)) continue;
      out.push({
        ...run,
        project: state.project,
        orgRoot: state.orgRoot,
        spentUsd: state.spentUsd,
        parentRunId: state.parentRunId,
        origin: state.origin,
      });
    }
    return out;
  }

  runtimeEvents(runId: string, since = 0): RuntimeEnvelope[] {
    return this.buffer.read(runId, since);
  }

  onRuntimeEvent(cb: (e: RuntimeEnvelope) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  active(): { running: number; queued: number; waiting: number } {
    return { running: this.live.size, queued: this.queue.length, waiting: 0 };
  }

  /**
   * An inbox answer: a human node continues the run; an approval continues it only when no
   * live task is blocked on it (the session was suspended or the daemon restarted).
   */
  async onInboxResolved(item: InboxItem, _answer: InboxAnswer): Promise<void> {
    if (this.live.has(item.runId)) return;
    if (this.queue.some((p) => p.runId === item.runId)) return;
    const state = await this.state(item.runId);
    if (isTerminal(state.status) || state.pendingApprovals.length > 0) return;
    if (state.status === 'waiting_human' && state.pendingHumans.length > 0) return;
    this.enqueue({
      runId: item.runId,
      action: state.status === 'queued' ? 'run' : 'resume',
      settle: [],
    });
  }

  private enqueue(p: Pending): void {
    const existing = this.queue.find((q) => q.runId === p.runId);
    if (existing) {
      existing.settle.push(...p.settle);
      return;
    }
    this.queue.push(p);
    this.pump();
  }

  private runningOfOrg(orgRoot: string): number {
    let n = 0;
    for (const a of this.live.values()) if (a.orgRoot === orgRoot) n++;
    return n;
  }

  /**
   * Starts every queued run the limits allow. Entries are claimed synchronously (removed
   * from the queue before any await) so re-entrant pumps never start the same run twice;
   * an entry whose org is full goes back to the queue.
   */
  private pump(): void {
    if (this.stopping || this.pumping) return;
    this.pumping = true;
    try {
      const candidates = [...this.queue];
      for (const p of candidates) {
        if (this.live.size + this.starting.size >= this.opts.config.max_concurrent_runs) return;
        if (this.starting.has(p.runId)) continue;
        this.dequeue(p);
        this.starting.add(p.runId);
        void this.startPending(p).then((outcome) => {
          this.starting.delete(p.runId);
          // an org-limited entry waits for a run to finish; pumping again now would spin
          if (outcome !== 'org-full') this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * A model name is checked against the provider's own listing when there is one (OpenRouter
   * with a key, a local server that answered): a typo fails here, not minutes later at the
   * provider. Providers without a live listing are not judged.
   */
  private async assertListed(model: string): Promise<void> {
    const listing = await this.opts.ready?.().catch(() => undefined);
    if (!Array.isArray(listing)) return;
    const provider = model.slice(0, model.indexOf('/'));
    const offered = (listing as { ref?: string; provider?: string; listed?: boolean }[]).filter(
      (m) => m.provider === provider && m.listed,
    );
    if (offered.length > 0 && !offered.some((m) => m.ref === model))
      throw new Error(
        `model "${model}" is not offered by ${provider} (see /model or \`shibaox models\` for what it lists)`,
      );
  }

  /** Starts one claimed run if its org has capacity; otherwise re-queues it. */
  private async startPending(p: Pending): Promise<'started' | 'failed' | 'org-full'> {
    let state: RunState;
    let prepared: Prepared;
    try {
      await this.opts.ready?.().catch(() => undefined);
      state = await this.state(p.runId);
      prepared = this.prepared.get(p.runId) ?? (await this.rebuild(state));
    } catch (e) {
      for (const s of p.settle) s.reject(e);
      this.opts.log(
        `[daemon] run ${p.runId} cannot start: ${e instanceof Error ? e.message : String(e)}`,
      );
      return 'failed';
    }
    if (this.stopping) return 'failed';
    const orgRoot = state.orgRoot ?? prepared.org.root;
    const limit = prepared.org.org.max_concurrent_runs ?? ORG_DEFAULT_CONCURRENCY;
    if (this.runningOfOrg(orgRoot) >= limit) {
      // keep the engine for the next pump; the run stays queued in the log
      this.prepared.set(p.runId, prepared);
      if (!this.queue.some((q) => q.runId === p.runId)) this.queue.push(p);
      return 'org-full';
    }
    this.prepared.delete(p.runId);
    const token = {};
    this.live.set(p.runId, { orgRoot, engine: prepared.engine, token });
    void this.execute(p, prepared, token);
    return 'started';
  }

  private dequeue(p: Pending): void {
    const i = this.queue.indexOf(p);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private async execute(p: Pending, prepared: Prepared, token: object): Promise<void> {
    let result: RunState | undefined;
    try {
      result =
        p.action === 'run'
          ? await prepared.engine.run(p.runId)
          : await prepared.engine.resume(p.runId, { budgetUsd: p.budgetUsd });
      for (const s of p.settle) s.resolve(result);
    } catch (e) {
      this.opts.log(
        `[daemon] run ${p.runId} failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      for (const s of p.settle) s.reject(e);
    } finally {
      if (this.live.get(p.runId)?.token === token) this.live.delete(p.runId);
      if (result && isTerminal(result.status)) {
        const { notePath } = await finishRun(this.opts.store, prepared.org, result, {
          log: this.opts.log,
          vault: this.opts.vault,
          adapter: prepared.adapter,
        });
        this.buffer.retire(p.runId);
        if (result.origin && this.opts.onFinished)
          try {
            const events = await this.opts.store.read(p.runId);
            const workflow = result.workflowSnapshot ?? prepared.org.workflows[result.workflow];
            this.opts.onFinished(result, events, workflow, notePath);
          } catch (e) {
            this.opts.log(`warn: report: ${e instanceof Error ? e.message : String(e)}`);
          }
      }
      this.pump();
    }
  }

  /** The runtime for a run known only from its event log (after a restart or a resume). */
  private async rebuild(state: RunState): Promise<Prepared> {
    if (!state.orgRoot)
      throw new Error(`run ${state.runId} has no org recorded (started before phase 2A)`);
    let org: Org;
    try {
      org = loadOrg(state.orgRoot);
    } catch (e) {
      throw new Error(
        `cannot load the org at ${state.orgRoot}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const adapter = isAdapterId(state.adapter) ? state.adapter : effectiveAdapter(undefined, org);
    const workflow = state.workflowSnapshot ?? org.workflows[state.workflow];
    const project = state.project ?? state.workspace;
    const graph = await this.graphFor({
      project,
      org,
      workflow,
      request: String(state.input.spec ?? ''),
      adapter,
    });
    const engine = this.buildEngine(org, {
      adapter,
      workflow,
      budgetUsd: state.budgetUsd,
      graph,
      runId: state.runId,
      project,
      workspaceMode: state.workspaceMode,
      origin: state.origin,
      model: state.model,
      warn: (w) => this.opts.log(`warn: ${w}`),
    });
    return { engine, org, adapter };
  }

  private async graphFor(a: {
    project: string;
    org: Org;
    workflow: Workflow | undefined;
    request: string;
    adapter: AdapterId;
    mode?: GraphMode;
  }) {
    return prepareGraph({
      project: a.project,
      org: a.org,
      workflow: a.workflow,
      request: a.request,
      adapter: a.adapter,
      opts: { log: this.opts.log, env: this.opts.env, graph: a.mode, graphify: this.opts.graphify },
    });
  }

  private buildEngine(
    org: Org,
    r: {
      adapter: AdapterId;
      workflow?: Workflow;
      budgetUsd?: number;
      graph?: GraphWiring;
      runId?: string;
      /** The main project checkout (tools and the preamble are built for it). */
      project?: string;
      workspaceMode?: WorkspaceMode;
      origin?: string;
      model?: string;
      warn: (w: string) => void;
    },
  ): RunEngine {
    const { engine, warnings } = buildRuntime({
      tools: this.taskTools(org, r),
      model: r.model,
      org,
      store: this.opts.store,
      human: this.opts.inbox,
      approvals: this.opts.inbox,
      log: this.opts.log,
      adapter: r.adapter,
      workflow: r.workflow,
      budgetUsd: r.budgetUsd,
      env: this.opts.env,
      extraProviders: this.opts.extraProviders,
      queryFn: this.opts.queryFn,
      graph: r.graph,
      newRunId: r.runId ? () => r.runId as string : undefined,
      mockScript: this.opts.mockScript,
      onRuntimeEvent: (runId, nodeId, e) => {
        const env = this.buffer.push(runId, nodeId, e, this.now());
        for (const l of this.listeners)
          try {
            l(env);
          } catch {
            // a broken subscriber never breaks a run
          }
      },
    });
    for (const w of warnings) r.warn(w);
    return engine;
  }

  /**
   * What every task of a run gets from the daemon: the project profile line for all roles, the
   * memory notes (as data) for roles with the `memory` capability, `start_workflow` for roles
   * with `orchestrate` (never on event turns) and `remember`/`recall` for `memory`. The profile
   * is computed when the first task starts, not on submit.
   */
  private taskTools(
    org: Org,
    r: {
      adapter: AdapterId;
      workflow?: Workflow;
      runId?: string;
      project?: string;
      workspaceMode?: WorkspaceMode;
      origin?: string;
      model?: string;
    },
  ): RuntimeOptions['tools'] {
    const project = r.project;
    if (!project || r.adapter === 'mock') return undefined;
    const vault = vaultDir(org, { vault: this.opts.vault });
    const log = this.opts.log;
    let profiled = false;
    let profileSummary: string | undefined;
    const summary = () => {
      if (profiled) return profileSummary;
      profiled = true;
      try {
        profileSummary = profileFor(project, { vault, log }).summary;
      } catch (e) {
        log(`warn: project profile: ${e instanceof Error ? e.message : String(e)}`);
      }
      return profileSummary;
    };
    let notes: MemoryNotes | undefined;
    if (vault)
      try {
        notes = new MemoryNotes({ vault, project: projectName(project) });
      } catch (e) {
        log(`warn: memory notes: ${e instanceof Error ? e.message : String(e)}`);
      }
    const workflows = Object.values(org.workflows).map((w) => ({
      name: w.workflow,
      description: w.description,
    }));
    const current = r.workflow?.workflow ?? '';
    const orchestration = r.runId
      ? orchestrationTools({
          runId: r.runId,
          current,
          workflows,
          startWorkflow: async (workflow, request) => {
            const { runId } = await this.submit({
              orgRoot: org.root,
              project,
              workflow,
              input: request,
              adapter: r.adapter,
              parentRunId: r.runId,
              // a dispatched run reports where its parent was asked from
              origin: r.origin,
              model: r.model,
            });
            return { runId };
          },
        })
      : [];
    const memory = notes ? memoryTools(notes) : [];
    return {
      preamble: (job) => {
        const profileSummary = summary();
        const withNotes = job.role.capabilities.includes('memory') ? notes : undefined;
        const p = withNotes?.preamble({ profileSummary });
        return p || (profileSummary ? `Project: ${profileSummary}` : undefined);
      },
      extra: (job) => toolsForRole(job.role, job.input, { orchestration, memory }),
    };
  }

  /** An engine that only needs the event log (suspend/cancel without adapters). */
  private lightEngine(): RunEngine {
    return new RunEngine({
      store: this.opts.store,
      org: {
        root: '',
        org: { organization: '', budgets: {}, teams: [] },
        teams: {},
        roles: {},
        workflows: {},
        gates: {},
        models: { providers: {}, tiers: {}, roles: {}, gates: {} },
        catalog: {},
      } as unknown as Org,
      adapters: {},
      decider: new ScriptedDecider({}),
      human: this.opts.inbox,
      log: this.opts.log,
    });
  }
}
