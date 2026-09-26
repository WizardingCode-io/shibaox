import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import {
  type EventStore,
  isTerminal,
  type MockScript,
  RunEngine,
  type RunState,
  type RunStatus,
  type RunSummary,
  replay,
  ScriptedDecider,
} from '@shibaox/core';
import type { Graphify } from '@shibaox/memory';
import type { ProviderEntry } from '@shibaox/providers';
import { loadOrg, type Org, type Workflow } from '@shibaox/schemas';
import { createRunWorkspace, type WorkspaceMode } from '@shibaox/workspace';
import type { DaemonConfig } from './config.js';
import type { InboxAnswer, InboxItem, InboxService } from './inbox.js';
import { type DiffResult, diffWorkspace, worktreeBase } from './runs/diff.js';
import { type GraphMode, prepareGraph } from './runs/graph.js';
import { finishRun } from './runs/notes.js';
import {
  assertProjectDir,
  gitPrefix,
  projectOf,
  workspaceMode,
  worktreeOf,
} from './runs/workspace.js';
import {
  type AdapterId,
  buildRuntime,
  effectiveAdapter,
  type GraphWiring,
  isAdapterId,
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
}

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
}

export interface RunSummaryPlus extends RunSummary {
  project?: string;
  orgRoot?: string;
  spentUsd: number;
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
  async submit(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }> {
    if (this.stopping) throw new Error('the daemon is stopping');
    const orgRoot = resolve(req.orgRoot);
    const org = loadOrg(orgRoot);
    const project = resolve(req.project);
    assertProjectDir(project);
    const wf = org.workflows[req.workflow];
    if (!wf) throw new Error(`workflow "${req.workflow}" is not defined in the org`);
    const adapter = effectiveAdapter(req.adapter, org);
    const warnings: string[] = [];
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
      warn: (w) => warnings.push(w),
    });
    const ws = await createRunWorkspace({ project, runId, mode });
    const workspace = ws.mode === 'worktree' ? join(ws.path, await gitPrefix(project)) : ws.path;
    await engine.create({
      workflow: req.workflow,
      input: { spec: req.input },
      workspace,
      budgetUsd,
      adapter,
      workspaceMode: ws.mode,
      project,
      branch: ws.branch,
      orgRoot,
    });
    this.prepared.set(runId, { engine, org, adapter });
    this.enqueue({ runId, action: 'run', settle: [] });
    return { runId, warnings };
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

  /** Starts one claimed run if its org has capacity; otherwise re-queues it. */
  private async startPending(p: Pending): Promise<'started' | 'failed' | 'org-full'> {
    let state: RunState;
    let prepared: Prepared;
    try {
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
        await finishRun(this.opts.store, prepared.org, result, {
          log: this.opts.log,
          vault: this.opts.vault,
          adapter: prepared.adapter,
        });
        this.buffer.retire(p.runId);
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
      warn: (w: string) => void;
    },
  ): RunEngine {
    const { engine, warnings } = buildRuntime({
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
