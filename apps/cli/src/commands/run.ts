import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import type { EventStore, HumanHandler, RunEngine, RunState } from '@shibaox/core';
import {
  type AdapterId,
  assertProjectDir,
  buildRuntime,
  effectiveAdapter,
  finishRun,
  type GraphMode,
  type GraphWiring,
  gitPrefix,
  logWorktree,
  prepareGraph,
  projectName,
  projectOf,
  workspaceMode,
  worktreeOf,
} from '@shibaox/daemon';
import type { Graphify } from '@shibaox/memory';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import { loadOrg, type Org, type Workflow } from '@shibaox/schemas';
import { createRunWorkspace, type WorkspaceMode } from '@shibaox/workspace';
import { TerminalHuman } from '../terminal-human.js';

export { finishRun, type GraphMode, logWorktree, prepareGraph, projectName, projectOf, worktreeOf };

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
    human: opts.human ?? new TerminalHuman(),
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

export function printState(state: RunState): void {
  console.log(
    `\nrun ${state.runId}  workflow=${state.workflow}  status=${state.status}  spent=$${state.spentUsd.toFixed(4)}`,
  );
  for (const [id, n] of Object.entries(state.nodes))
    console.log(
      `  ${id.padEnd(22)} ${n.status.padEnd(11)} attempts=${n.attempts}${n.choice ? ` choice=${n.choice}` : ''}${n.error ? ` error=${n.error}` : ''}`,
    );
  if (state.error) console.log(`  error: ${state.error}`);
  for (const p of state.pendingHumans)
    console.log(`  waiting for human at ${p.nodeId}: ${p.prompt}`);
}
