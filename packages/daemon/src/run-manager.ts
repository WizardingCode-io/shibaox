import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@wizardingcode/shibaox-adapter-claude-code';
import { connectMcp, fetchBytes } from '@wizardingcode/shibaox-adapter-direct';
import {
  type AgentTool,
  type ApprovalHandler,
  AutoApproveHuman,
  compactConversation,
  detectSetupCommand,
  type EventStore,
  isProtected,
  isTerminal,
  type MockScript,
  mcpServerSpec,
  RunEngine,
  type RunState,
  type RunStatus,
  type RunSummary,
  type RuntimeEvent,
  replay,
  ScriptedDecider,
  type StoredEvent,
  type TaskJob,
} from '@wizardingcode/shibaox-core';
import { type Graphify, MemoryNotes } from '@wizardingcode/shibaox-memory';
import type { ProviderEntry } from '@wizardingcode/shibaox-providers';
import type { CatalogEntry, RoutineApprovals } from '@wizardingcode/shibaox-schemas';
import {
  type ChatMessage,
  loadOrg,
  loadProjectFile,
  type Org,
  type Workflow,
} from '@wizardingcode/shibaox-schemas';
import {
  createRunWorkspace,
  ensureExcluded,
  removeRunWorkspace,
  type WorkspaceMode,
} from '@wizardingcode/shibaox-workspace';
import type { DaemonConfig, HiggsfieldMode } from './config.js';
import { HIGGSFIELD_API, runtimeHiggsfieldMode } from './higgsfield.js';
import type { InboxAnswer, InboxItem, InboxService } from './inbox.js';
import { projectProtectedGlobs } from './protected.js';
import { type DiffResult, diffWorkspace, worktreeBase } from './runs/diff.js';
import {
  ALWAYS_PROTECTED,
  type Attachment,
  confine,
  listRunFiles,
  planAttachments,
  type RunFile,
  type RunFileContent,
  RunFileError,
  readRunFile,
  writeAttachments,
  writeRunFile,
} from './runs/files.js';
import { type GraphMode, prepareGraph } from './runs/graph.js';
import { higgsfieldApiTools, saveInto } from './runs/higgsfield-api-tools.js';
import { type HiggsfieldPlan, higgsfieldPlan } from './runs/higgsfield-gate.js';
import { higgsfieldTools, uploadTimeoutMs } from './runs/higgsfield-tools.js';
import { finishRun, vaultDir } from './runs/notes.js';
import { memoryTools, orchestrationTools, toolsForRole } from './runs/orchestration.js';
import { profileFor } from './runs/profile.js';
import type { Summarizer } from './runs/summarize.js';
import { type TelegramSendResult, telegramTools } from './runs/telegram-tools.js';
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
  adapterForTiers,
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
  /** The conversation this run belongs to: given for a chat turn, inherited from the parent, else the run itself. */
  thread?: string;
  /** A model ref (`provider/model`) for every task of the run; the adapter follows from it. */
  model?: string;
  /** Files sent with the message: written under attachments/ in the workspace before the run. */
  attachments?: Attachment[];
  /**
   * The dependency install of a worktree run: `auto` (default: `shibaox.yaml setup`, else
   * detected from the lockfile), `off`, or a command.
   */
  setup?: string;
  /** A JSON Schema the run's last task answers in (`start_workflow(output_schema)`); checked when it ends. */
  outputSchema?: Record<string, unknown>;
  /**
   * How approvals are answered: `inbox` (default) asks you; `auto` approves push, deploy,
   * commands, network and protected files by itself; `skip` answers human steps too. A
   * routine's policy; recorded on the run.
   */
  approvals?: RoutineApprovals;
}

/** A conversation carried into a run is compacted beyond this (estimated tokens). */
export const CONVERSATION_TOKENS = 32_000;

/** Where runtime events (tool calls, texts) live beyond the in-memory buffer: the SQLite table. */
export interface RuntimeStore {
  append(e: RuntimeEnvelope): void;
  read(runId: string, since?: number, types?: readonly string[]): RuntimeEnvelope[];
  /** The number the next event of the run gets. */
  nextSeq(runId: string): number;
  forget(runIds: string[]): void;
}

export interface RunManagerOptions {
  store: EventStore;
  /** Runtime events on disk; without it they live in the buffer only (tests). */
  runtimeStore?: RuntimeStore;
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
  /**
   * Higgsfield's mode (`partners.higgsfield.mode`), read when each task starts; `fetch` is the
   * API tools' (tests inject a fake).
   */
  higgsfield?: { mode(): HiggsfieldMode; fetch?: typeof fetch; base?: string };
  /** The daemon's Telegram send: roles with `telegram` in their tools get `telegram_send`. */
  telegram?: {
    send(text: string): Promise<TelegramSendResult>;
    sendFile(
      file: { bytes: Buffer; filename: string; mime: string },
      caption?: string,
    ): Promise<TelegramSendResult>;
  };
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
  /** The conversation the run belongs to (turns and their children share it). */
  thread?: string;
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
  private readonly buffer: RuntimeBuffer;
  private readonly listeners = new Set<(e: RuntimeEnvelope) => void>();
  private readonly starting = new Set<string>();
  /** Runs whose engine promise is still out (a cancelled task may keep going for a while). */
  private readonly inFlight = new Set<string>();
  /** Per running run: aborted on cancel/stop/end, so a tool waiting on Higgsfield stops too. */
  private readonly toolAborts = new Map<string, AbortController>();
  /** Per task: the Higgsfield path chosen when it started. */
  private readonly hfPlans = new WeakMap<TaskJob, HiggsfieldPlan>();
  private readonly now: () => string;
  private stopping = false;
  private pumping = false;

  constructor(private readonly opts: RunManagerOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    const rs = opts.runtimeStore;
    this.buffer = new RuntimeBuffer(2000, 50, rs ? (id) => rs.nextSeq(id) : undefined);
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
    const registry = registryFor(this.opts.env ?? process.env, this.opts.extraProviders);
    let adapter: AdapterId;
    if (model) adapter = adapterForModel(model, registry);
    else {
      const picked = adapterForTiers(req.adapter, org, registry);
      adapter = picked.adapter;
      if (picked.note) warnings.push(picked.note);
    }
    if (model) await this.assertListed(model);
    const mode = await workspaceMode(project, req.workspace, (l) => warnings.push(l));
    const budgetUsd = req.budgetUsd ?? org.org.budgets.per_run_usd;
    const runId = randomUUID();
    // a chat turn names its conversation; a dispatched run inherits its parent's; a root run is its own
    const thread =
      req.thread ??
      (req.parentRunId
        ? await this.state(req.parentRunId)
            .then((p) => p.thread)
            .catch(() => undefined)
        : undefined) ??
      runId;
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
      thread,
      model,
      approvals: req.approvals,
      warn: (w) => warnings.push(w),
    });
    // the message's files are checked (names, sizes, protection) before any workspace exists
    const planned =
      req.attachments && req.attachments.length > 0
        ? planAttachments(req.attachments, { protectedGlobs: projectProtectedGlobs(project) })
        : [];
    const ws = await createRunWorkspace({ project, runId, mode });
    const workspace = ws.mode === 'worktree' ? join(ws.path, await gitPrefix(project)) : ws.path;
    // the message's files go into the workspace first, and the message names them; a failure
    // leaves nothing behind (the worktree just made is removed)
    let attached: { path: string; size: number; mime?: string }[] = [];
    if (planned.length > 0 && req.attachments) {
      try {
        attached = await writeAttachments(workspace, req.attachments, {
          protectedGlobs: projectProtectedGlobs(project),
        });
        await ensureExcluded(project).catch(() => undefined); // not a git repository: fine
      } catch (e) {
        if (ws.mode === 'worktree')
          await removeRunWorkspace({ project, runId, deleteBranch: true }).catch(() => undefined);
        throw e;
      }
    }
    const input =
      attached.length > 0
        ? `${req.input}\n\n[Attached files]\n${attached.map((f) => `- ${f.path} (${sizeWords(f.size)}${f.mime ? `, ${f.mime}` : ''})`).join('\n')}`
        : req.input;
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
    const setup = setupFor({
      workspace,
      root: ws.path,
      mode: ws.mode,
      choice: req.setup,
      org: org.org.setup,
      warn: (w) => warnings.push(w),
    });
    await engine.create({
      workflow: req.workflow,
      input: {
        spec: input,
        ...(attached.length > 0 ? { attachments: attached } : {}),
        ...(messages.length > 0 ? { messages } : {}),
        ...(req.event ? { event: true } : {}),
        ...(req.outputSchema ? { output_schema: req.outputSchema } : {}),
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
      thread,
      model,
      approvals: req.approvals,
      setup,
    });
    for (const f of attached)
      this.recordRuntime(runId, 'you', { type: 'file_changed', path: f.path });
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
      this.abortTools(runId, 'daemon stopped');
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
    // a tool waiting on Higgsfield stops now (and cancels its request there)
    this.abortTools(runId, 'cancelled by the user');
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

  /** The files a run touched: its diff plus what it reported, with sizes (404 once the workspace is gone). */
  async files(runId: string): Promise<{ root: string; files: RunFile[] } | undefined> {
    const state = await this.state(runId);
    if (!existsSync(state.workspace)) return undefined;
    const diff = await this.diff(runId).catch(() => undefined);
    const changed = this.runtimeEvents(runId, 0, ['file_changed']).flatMap((e) => {
      const ev = e.event as { type: string; path?: string };
      return typeof ev.path === 'string' ? [ev.path] : [];
    });
    return { root: state.workspace, files: await listRunFiles(state.workspace, diff, changed) };
  }

  /** One file of the run's workspace (never outside it, never a protected one). */
  async fileContent(runId: string, path: string): Promise<RunFileContent> {
    const state = await this.state(runId);
    return readRunFile(state.workspace, path, { protectedGlobs: this.protectedFor(state) });
  }

  /** Work on a catalog MCP server from the daemon itself: one connection, closed after. */
  private async withMcp<T>(
    entry: CatalogEntry,
    f: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
  ): Promise<T> {
    const { tools: _allowlist, ...spec } = mcpServerSpec(entry, this.opts.env ?? process.env);
    const c = await connectMcp(spec, { log: this.opts.log });
    try {
      return await f((name, args) => c.call(name, args));
    } finally {
      await c.close();
    }
  }

  /** A runtime event of a run, buffered, stored and streamed to every subscriber. */
  private recordRuntime(runId: string, nodeId: string, e: RuntimeEvent): void {
    const env = this.buffer.push(runId, nodeId, e, this.now());
    try {
      this.opts.runtimeStore?.append(env);
    } catch (err) {
      this.opts.log(
        `warn: runtime event not stored: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const l of this.listeners)
      try {
        l(env);
      } catch {
        // a broken subscriber never breaks a run
      }
  }

  /**
   * Writes a text file into the run's workspace for the user (the app's "Save to project"):
   * same fence as reads, recorded as a `file_changed` of node `you` so it lists with the run's
   * files. Refused while a task of the run is running: it owns the workspace then.
   */
  async writeFile(
    runId: string,
    path: string,
    content: string,
  ): Promise<{ path: string; size: number }> {
    const state = await this.state(runId);
    if (state.status === 'running' || state.status === 'queued')
      throw new RunFileError('busy', 'The run is running: its tasks own the workspace now');
    // conversation turns share one checkout: a live turn owns it whatever run the file came from
    for (const id of this.live.keys()) {
      if (id === runId) continue;
      const other = await this.state(id).catch(() => undefined);
      if (other && other.workspace === state.workspace && other.status === 'running')
        throw new RunFileError(
          'busy',
          'A turn is running in this workspace: wait for it to finish',
        );
    }
    if (!existsSync(state.workspace))
      throw new RunFileError('no_workspace', 'The run workspace is gone');
    const r = await writeRunFile(state.workspace, path, content, {
      protectedGlobs: this.protectedFor(state),
    });
    this.recordRuntime(runId, 'you', { type: 'file_changed', path: r.path });
    if (isTerminal(state.status)) this.buffer.retire(runId);
    return r;
  }

  /** The real path of a file of the run's workspace, for a download (same rules as fileContent). */
  async filePath(
    runId: string,
    path: string,
  ): Promise<{ file: string; rel: string; size: number }> {
    const state = await this.state(runId);
    if (!existsSync(state.workspace))
      throw new RunFileError('no_workspace', 'The run workspace is gone');
    const c = confine(state.workspace, path);
    if (isProtected(c.rel, [...ALWAYS_PROTECTED, ...this.protectedFor(state)]))
      throw new RunFileError('protected', `${c.rel} is protected: it is never shown or downloaded`);
    const st = statSync(c.file);
    if (!st.isFile()) throw new RunFileError('not_found', `${c.rel} is not a file`);
    return { ...c, size: st.size };
  }

  /** Approves every tool request itself, writing the request and the answer like the inbox would. */
  private autoApprovals(): ApprovalHandler {
    return {
      request: async (req) => {
        const approvalId = randomUUID();
        const at = this.now();
        await this.opts.store.append({
          type: 'ToolApprovalRequested',
          runId: req.runId,
          nodeId: req.nodeId,
          at,
          approvalId,
          role: req.role,
          tool: req.tool,
          program: req.program,
          category: req.category,
          command: req.command,
          argvHash: createHash('sha256').update(req.argv.join('\0')).digest('hex').slice(0, 16),
        });
        await this.opts.store.append({
          type: 'ToolApprovalResolved',
          runId: req.runId,
          nodeId: req.nodeId,
          at: this.now(),
          approvalId,
          approved: true,
          note: 'auto-approved (the routine policy)',
          via: 'auto',
        });
        return { approved: true, note: 'auto-approved (the routine policy)' };
      },
    };
  }

  private protectedFor(state: RunState): string[] {
    try {
      return projectProtectedGlobs(projectOf(state));
    } catch {
      return [];
    }
  }

  async list(
    filter: { status?: RunStatus; orgRoot?: string; parent?: string; thread?: string } = {},
  ): Promise<RunSummaryPlus[]> {
    const out: RunSummaryPlus[] = [];
    for (const run of await this.opts.store.listRuns()) {
      if (filter.status && run.status !== filter.status) continue;
      const state = replay(await this.opts.store.read(run.runId));
      if (filter.orgRoot && state.orgRoot !== resolve(filter.orgRoot)) continue;
      if (filter.parent && state.parentRunId !== filter.parent) continue;
      if (filter.thread && state.thread !== filter.thread) continue;
      out.push({
        ...run,
        project: state.project,
        orgRoot: state.orgRoot,
        spentUsd: state.spentUsd,
        parentRunId: state.parentRunId,
        origin: state.origin,
        thread: state.thread,
      });
    }
    return out;
  }

  /**
   * From the buffer when it holds everything after `since`; else from the runtime store.
   * `types` narrows to some event types (the audit wants tool calls, not every text delta).
   */
  runtimeEvents(runId: string, since = 0, types?: readonly string[]): RuntimeEnvelope[] {
    const store = this.opts.runtimeStore;
    const first = this.buffer.firstSeq(runId);
    const fromBuffer = !store || (first !== undefined && first <= since + 1);
    const all = fromBuffer ? this.buffer.read(runId, since) : store.read(runId, since, types);
    return types && fromBuffer ? all.filter((e) => types.includes(e.event.type)) : all;
  }

  /** Redirects the running task of a live run (see `RunEngine.steer`); a run that is not live has nothing to steer. */
  async steer(
    runId: string,
    o: { nodeId?: string; note: string; via: 'cli' | 'telegram' | 'api' | 'orchestrator' },
  ): Promise<RunState> {
    const a = this.live.get(runId);
    if (!a) {
      const state = await this.state(runId); // throws not found
      throw new Error(`run ${runId} is ${state.status}: nothing to steer`);
    }
    return a.engine.steer(runId, o);
  }

  /**
   * Removes finished runs older than `before` (ISO date) from every store; returns their ids.
   * A run whose task is still out there (cancelled, but its runtime has not returned) stays:
   * a late event on an empty log would break the run list.
   */
  async prune(before: string): Promise<string[]> {
    const keep = [...this.live.keys(), ...this.inFlight, ...this.starting, ...this.prepared.keys()];
    const removed = (await this.opts.store.prune?.(before, keep)) ?? [];
    if (removed.length === 0) return removed;
    this.opts.runtimeStore?.forget(removed);
    this.buffer.drop(removed);
    return removed;
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
    // every entry of the provider counts (the catalog's picks too) once its listing is live
    const entries = (listing as { ref?: string; provider?: string; listed?: boolean }[]).filter(
      (m) => m.provider === provider,
    );
    if (!entries.some((m) => m.listed)) return;
    const wanted = new Set([model, `${model}:latest`]); // Ollama lists "llama3.2" as "llama3.2:latest"
    if (!entries.some((m) => m.ref !== undefined && wanted.has(m.ref)))
      throw new Error(
        `model "${model}" is not offered by ${provider} (see /model in the dashboard for what it lists)`,
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
    this.inFlight.add(p.runId);
    this.toolAborts.set(p.runId, new AbortController());
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
      this.abortTools(p.runId, 'the run left the engine', true);
      this.inFlight.delete(p.runId);
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
      approvals: state.approvals,
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
      /** The conversation the run belongs to (its orchestrator sees every run dispatched in it). */
      thread?: string;
      model?: string;
      approvals?: RoutineApprovals;
      warn: (w: string) => void;
    },
  ): RunEngine {
    const policy = r.approvals === 'auto' || r.approvals === 'skip' ? r.approvals : 'inbox';
    const { engine, warnings } = buildRuntime({
      tools: this.taskTools(org, r),
      // the account's MCP never starts in API mode (decided per task)
      skipMcp: (job, id) => id === 'higgsfield' && this.hfPlan(org, job).skipMcp,
      model: r.model,
      org,
      store: this.opts.store,
      // `auto`: tool approvals answer themselves (on the record); `skip`: the workflow's human steps too
      human: policy === 'skip' ? new AutoApproveHuman() : this.opts.inbox,
      approvals: policy === 'inbox' ? this.opts.inbox : this.autoApprovals(),
      log: this.opts.log,
      adapter: r.adapter,
      workflow: r.workflow,
      budgetUsd: r.budgetUsd,
      env: this.opts.env,
      extraProviders: this.opts.extraProviders,
      queryFn: this.opts.queryFn,
      project: r.project,
      graph: r.graph,
      newRunId: r.runId ? () => r.runId as string : undefined,
      mockScript: this.opts.mockScript,
      onRuntimeEvent: (runId, nodeId, e) => this.recordRuntime(runId, nodeId, e),
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
      thread?: string;
      model?: string;
      approvals?: RoutineApprovals;
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
          startWorkflow: async (workflow, request, o) => {
            const { runId } = await this.submit({
              orgRoot: org.root,
              project,
              workflow,
              input: request,
              adapter: r.adapter,
              parentRunId: r.runId,
              // a dispatched run reports where its parent was asked from, in the same conversation
              origin: r.origin,
              thread: r.thread,
              model: r.model,
              // a routine that never asks keeps not asking in the runs it dispatches
              approvals: r.approvals,
              outputSchema: o?.outputSchema,
            });
            return { runId };
          },
          thread: r.thread,
          listRuns: () =>
            r.thread ? this.list({ thread: r.thread }) : this.list({ parent: r.runId }),
          runStatus: (id) => this.state(id),
          steerRun: async (id, note) => {
            await this.steer(id, { note, via: 'orchestrator' });
            return { ok: true };
          },
          cancelRun: async (id) => {
            await this.cancel(id);
            return { ok: true };
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
      extra: (job) => [
        ...toolsForRole(job.role, job.input, { orchestration, memory }),
        ...this.higgsfieldTools(org, job, project, r.runId),
        ...(this.opts.telegram && job.role.tools.includes('telegram')
          ? telegramTools({
              ...this.opts.telegram,
              workspace: job.workspace,
              protectedGlobs: projectProtectedGlobs(project),
            })
          : []),
      ],
    };
  }

  /** `account` or `api` for the task starting now (`auto`: the API when a key is saved). */
  private hfMode(): 'account' | 'api' {
    const env = this.opts.env ?? process.env;
    return runtimeHiggsfieldMode(this.opts.higgsfield?.mode() ?? 'auto', !!env.HIGGSFIELD_API_KEY);
  }

  /** The task's Higgsfield plan, decided once per task (its MCP servers and tools agree). */
  private hfPlan(org: Org, job: TaskJob): HiggsfieldPlan {
    let plan = this.hfPlans.get(job);
    if (!plan) {
      plan = higgsfieldPlan(job.role, this.hfMode(), !!org.catalog.higgsfield?.server);
      this.hfPlans.set(job, plan);
    }
    return plan;
  }

  /** The signal a run's tools listen to: aborted when the run is cancelled, stopped or ends. */
  toolSignal(runId: string): AbortSignal | undefined {
    return this.toolAborts.get(runId)?.signal;
  }

  /**
   * Aborts the run's tool signal; the aborted controller stays until the run leaves the engine
   * (`release`), so a tool that reads it late still sees the abort.
   */
  private abortTools(runId: string, reason: string, release = false): void {
    const c = this.toolAborts.get(runId);
    if (!c) return;
    if (!c.signal.aborted) c.abort(new Error(reason));
    if (release) this.toolAborts.delete(runId);
  }

  /**
   * Higgsfield for a task, one path only: the account's upload (with the MCP server) or the
   * API tools (the key read from the live environment at each call, never handed to a model).
   */
  private higgsfieldTools(
    org: Org,
    job: TaskJob,
    project: string,
    runId: string | undefined,
  ): AgentTool[] {
    const entry = org.catalog.higgsfield;
    const plan = this.hfPlan(org, job);
    const env = this.opts.env ?? process.env;
    if (plan.apiTools) {
      const signal = runId ? this.toolSignal(runId) : undefined;
      return higgsfieldApiTools({
        key: () => env.HIGGSFIELD_API_KEY || undefined,
        fetch: this.opts.higgsfield?.fetch ?? fetch,
        // from the launch env (the daemon's `apiBase`), never the run env: it has the vault
        base: this.opts.higgsfield?.base ?? HIGGSFIELD_API,
        workspace: job.workspace,
        protectedGlobs: projectProtectedGlobs(project),
        // captured now: the run's controller, even once it is aborted
        signal: () => signal,
        log: this.opts.log,
        // results land in outputs/ of the workspace and list with the run's files
        save: async (url, name) => {
          const { bytes } = await fetchBytes(url, {
            timeoutMs: 120_000,
            maxBytes: 200 * 1024 * 1024,
            allow: ['*'],
          });
          const path = await saveInto(job.workspace, projectProtectedGlobs(project), name, bytes);
          if (runId) this.recordRuntime(runId, job.nodeId, { type: 'file_changed', path });
          return path;
        },
      });
    }
    if (plan.upload && entry)
      // a role with Higgsfield's server gets the upload the model cannot do itself
      return higgsfieldTools({
        workspace: job.workspace,
        protectedGlobs: projectProtectedGlobs(project),
        withMcp: (f) => this.withMcp(entry, f),
        put: async (url, bytes, contentType) => {
          const r = await fetch(url, {
            method: 'PUT',
            headers: { 'content-type': contentType, 'content-length': String(bytes.length) },
            body: bytes as unknown as BodyInit,
            signal: AbortSignal.timeout(uploadTimeoutMs(bytes.length)),
          });
          return { status: r.status, body: await r.text().catch(() => '') };
        },
      });
    return [];
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

/**
 * What a fresh worktree needs before anything runs: `off` (the request or `org.yaml setup`)
 * for nothing, a command as given, else `shibaox.yaml setup` or the lockfile's install, run
 * where the lockfile is (a monorepo package). In place there is nothing to install.
 */
function setupFor(o: {
  workspace: string;
  root: string;
  mode: WorkspaceMode;
  choice: string | undefined;
  org: 'auto' | 'off';
  warn: (w: string) => void;
}): { command: string; timeoutMs?: number } | undefined {
  const choice = o.choice?.trim() || undefined;
  const explicit = choice !== undefined && choice !== 'auto' && choice !== 'off';
  if (o.mode !== 'worktree') {
    if (explicit) o.warn('setup: the run is in place, nothing to install: the command was not run');
    return undefined;
  }
  if (choice === 'off' || (!explicit && o.org === 'off')) return undefined;
  let timeoutMs: number | undefined;
  try {
    timeoutMs = loadProjectFile(o.workspace)?.setup_timeout_ms;
  } catch (e) {
    o.warn(
      `${e instanceof Error ? e.message : String(e)} (ignored: the lockfile decides the setup)`,
    );
  }
  const plan = explicit
    ? { command: choice as string, cwd: '.' }
    : detectSetupCommand(o.workspace, o.root);
  if (!plan) return undefined;
  const command = plan.cwd === '.' ? plan.command : `cd '${plan.cwd}' && ${plan.command}`;
  return { command, timeoutMs };
}

/** `8 B`, `12.3 KB`, `1.5 MB`. */
const sizeWords = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1048576
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1048576).toFixed(1)} MB`;
