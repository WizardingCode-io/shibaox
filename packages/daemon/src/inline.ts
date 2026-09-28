import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@wizardingcode/shibaox-adapter-claude-code';
import {
  DeferHuman,
  type EventStore,
  type HumanHandler,
  isTerminal,
  type RunEngine,
  type RunState,
  replay,
} from '@wizardingcode/shibaox-core';
import type { Graphify } from '@wizardingcode/shibaox-memory';
import { SqliteEventStore } from '@wizardingcode/shibaox-persistence-sqlite';
import type { ProviderEntry } from '@wizardingcode/shibaox-providers';
import { loadOrg, type Org, type Workflow } from '@wizardingcode/shibaox-schemas';
import { createRunWorkspace, type WorkspaceMode } from '@wizardingcode/shibaox-workspace';
import { type GraphMode, prepareGraph } from './runs/graph.js';
import { finishRun, logWorktree } from './runs/notes.js';
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

/**
 * The in-process run path (no daemon): one run per call, humans deferred unless a handler
 * is given. The CLI used it until phase 2A; it stays as a library entry for embedding and
 * for the wiring tests.
 */
export interface EngineOptions {
  /** Runtime adapter; when omitted, `adapter:` in org.yaml, else `mock`. */
  adapter?: AdapterId;
  human?: HumanHandler;
  log?: (line: string) => void;
  /** Environment for provider keys and Jev (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Providers added to the built-in catalog. */
  extraProviders?: ProviderEntry[];
  /** `auto` (default): use `graphify-out/graph.json` when it exists; never builds it. */
  graph?: GraphMode;
  /** The SDK `query` for the Claude Code adapter (tests inject a fake). */
  queryFn?: QueryFn;
  /** Graphify runner (tests inject one with a fake exec). */
  graphify?: Graphify;
  /** Vault directory; overrides `vault:` in org.yaml. */
  vault?: string;
}

export interface RunOptions extends EngineOptions {
  org: string;
  project: string;
  input: string;
  budget?: number;
  db?: string;
  /** Default: `worktree` when the project is a git repository, else `inplace`. */
  workspace?: WorkspaceMode;
}

export function dbPath(orgDir: string, override?: string): string {
  const path = override ?? join(orgDir, '.shibaox', 'events.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
}

const logOf = (opts: EngineOptions) => opts.log ?? ((l: string) => console.log(l));

/**
 * The engine shared by `run` and `resume`, built by `buildRuntime`; prints its
 * warnings. Throws `cannot start: ...` (before any event is written) when a
 * task role of `run.workflow` cannot resolve for the adapter.
 */
export function buildEngine(
  store: EventStore,
  org: Org,
  opts: EngineOptions,
  run: { workflow?: Workflow; budgetUsd?: number; graph?: GraphWiring; runId?: string } = {},
): RunEngine {
  const log = logOf(opts);
  const runId = run.runId;
  const { engine, warnings } = buildRuntime({
    org,
    store,
    human: opts.human ?? new DeferHuman(),
    log,
    adapter: opts.adapter,
    workflow: run.workflow,
    budgetUsd: run.budgetUsd,
    env: opts.env,
    extraProviders: opts.extraProviders,
    queryFn: opts.queryFn,
    graph: run.graph,
    newRunId: runId ? () => runId : undefined,
  });
  for (const w of warnings) log(`warn: ${w}`);
  return engine;
}

export async function runWorkflow(workflow: string, opts: RunOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const project = resolve(opts.project);
  assertProjectDir(project);
  const wf = org.workflows[workflow];
  if (!wf) throw new Error(`workflow "${workflow}" is not defined in the org`);
  const adapter = effectiveAdapter(opts.adapter, org);
  const mode = await workspaceMode(project, opts.workspace, logOf(opts));
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const budgetUsd = opts.budget ?? org.org.budgets.per_run_usd;
    const graph = await prepareGraph({
      project,
      org,
      workflow: wf,
      request: opts.input,
      adapter,
      opts: { ...opts, log: logOf(opts) },
    });
    const runId = randomUUID();
    // builds (and checks) the runtime before the worktree exists
    const engine = buildEngine(store, org, opts, { workflow: wf, budgetUsd, graph, runId });
    const ws = await createRunWorkspace({ project, runId, mode });
    const workspace = ws.mode === 'worktree' ? join(ws.path, await gitPrefix(project)) : ws.path;
    const state = await engine.start({
      workflow,
      input: { spec: opts.input },
      workspace,
      budgetUsd,
      adapter,
      workspaceMode: ws.mode,
      project,
      branch: ws.branch,
    });
    await finishRun(store, org, state, { ...opts, log: logOf(opts), adapter });
    logWorktree(state, logOf(opts));
    return state;
  } finally {
    store.close();
  }
}

export function printState(state: RunState, out: (line: string) => void = console.log): void {
  out(
    `\nrun ${state.runId}  workflow=${state.workflow}  status=${state.status}  spent=$${state.spentUsd.toFixed(4)}`,
  );
  for (const [id, n] of Object.entries(state.nodes))
    out(
      `  ${id.padEnd(22)} ${n.status.padEnd(11)} attempts=${n.attempts}${n.choice ? ` choice=${n.choice}` : ''}${n.error ? ` error=${n.error}` : ''}`,
    );
  if (state.error) out(`  error: ${state.error}`);
  for (const p of state.pendingHumans) out(`  waiting for human at ${p.nodeId}: ${p.prompt}`);
}

export interface ResumeOptions extends EngineOptions {
  org: string;
  budget?: number;
  db?: string;
}

/**
 * Continues a run from the event log: re-asks pending humans (through the
 * terminal when interactive), resumes a budget pause with `budget`, or
 * re-runs nodes interrupted by a crash. Without `adapter` it keeps the adapter
 * the run was started with. Writes the vault notes when the run ends here.
 */
export async function resumeRun(runId: string, opts: ResumeOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const events = await store.read(runId);
    const prior = events.length > 0 ? replay(events) : undefined;
    const wt = prior && !isTerminal(prior.status) ? worktreeOf(prior) : undefined;
    if (wt && !existsSync(wt.path))
      throw new Error(
        `cannot resume run ${runId}: its worktree ${wt.path} no longer exists (see: shibaox worktree list)`,
      );
    const recorded = isAdapterId(prior?.adapter) ? prior?.adapter : undefined;
    const adapter = opts.adapter ?? recorded ?? effectiveAdapter(undefined, org);
    const workflow = prior && (prior.workflowSnapshot ?? org.workflows[prior.workflow]);
    const graph = prior
      ? await prepareGraph({
          project: projectOf(prior),
          org,
          workflow,
          request: String(prior.input.spec ?? ''),
          adapter,
          opts: { ...opts, log: opts.log ?? ((l: string) => console.log(l)) },
        })
      : undefined;
    // same adapter rules as `run`: resolve the run's own workflow up front
    const engine = buildEngine(
      store,
      org,
      { ...opts, adapter },
      { workflow, budgetUsd: opts.budget ?? prior?.budgetUsd, graph },
    );
    const state = await engine.resume(runId, { budgetUsd: opts.budget });
    if (prior && !isTerminal(prior.status))
      await finishRun(store, org, state, {
        ...opts,
        log: opts.log ?? ((l: string) => console.log(l)),
        adapter,
      });
    logWorktree(state, opts.log ?? ((l: string) => console.log(l)));
    return state;
  } finally {
    store.close();
  }
}
