import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import {
  type EventStore,
  type HumanHandler,
  isTerminal,
  type RunEngine,
  type RunState,
  runArgv,
  selectCapabilities,
} from '@shibaox/core';
import { JevClient, noulFanOut } from '@shibaox/jev';
import { Graphify, graphJsonPath, writeDecisionNote, writeRunNote } from '@shibaox/memory';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import { loadOrg, type Org, type Workflow } from '@shibaox/schemas';
import { createRunWorkspace, isGitRepo, type WorkspaceMode } from '@shibaox/workspace';
import { TerminalHuman } from '../terminal-human.js';
import { type AdapterId, buildRuntime, effectiveAdapter, type GraphWiring } from '../wiring.js';

export type GraphMode = 'auto' | 'off';

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

function assertProjectDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`project path not found: ${path}`);
}

/** The first task role of the workflow (its `start` node when that is a task). */
function firstTaskRole(workflow: Workflow): string | undefined {
  const start = workflow.nodes[workflow.start];
  if (start?.type === 'task') return start.role;
  for (const node of Object.values(workflow.nodes)) if (node.type === 'task') return node.role;
  return undefined;
}

/**
 * Autorouting v0, once per run: the org catalog against the workflow's first task role,
 * deterministic without Jev, fanned out through Jev when it is configured (and the run is
 * not a mock run). `undefined` when the org has no catalog.
 */
async function autoroute(
  org: Org,
  workflow: Workflow,
  request: string,
  opts: { adapter: AdapterId; env: NodeJS.ProcessEnv; log: (l: string) => void },
) {
  const catalog = Object.values(org.catalog);
  const roleName = firstTaskRole(workflow);
  const role = roleName ? org.roles[roleName] : undefined;
  if (catalog.length === 0 || !role) return undefined;
  const team = workflow.team ? org.teams[workflow.team] : undefined;
  const key = opts.env.TYPESAFE_API_KEY;
  const fanOut =
    key && opts.adapter !== 'mock'
      ? noulFanOut(
          new JevClient({ apiKey: key, baseURL: opts.env.SHIBAOX_JEV_BASE_URL || undefined }),
        )
      : undefined;
  let r: Awaited<ReturnType<typeof selectCapabilities>>;
  try {
    r = await selectCapabilities({ request, role, team, catalog, fanOut });
  } catch (err) {
    opts.log(
      `warn: autorouting via Jev failed (${err instanceof Error ? err.message : String(err)}): using tag matching`,
    );
    r = await selectCapabilities({ request, role, team, catalog });
  }
  opts.log(`autoroute: attach=[${r.attach.join(', ')}] ambiguous=[${r.ambiguous.join(', ')}]`);
  return r;
}

/**
 * Wires the project's knowledge graph when `graphify-out/graph.json` exists (it is never
 * built here): `graph_query` for direct roles, the graphify MCP server for Claude Code roles
 * when autorouting attaches `graphify-mcp` or the catalog does not list it.
 */
export async function prepareGraph(args: {
  project: string;
  org: Org;
  workflow: Workflow | undefined;
  request: string;
  adapter: AdapterId;
  opts: EngineOptions;
}): Promise<GraphWiring | undefined> {
  const { project, org, workflow, adapter, opts } = args;
  const log = logOf(opts);
  const env = opts.env ?? process.env;
  const routed = workflow
    ? await autoroute(org, workflow, args.request, { adapter, env, log })
    : undefined;
  const graphJson = graphJsonPath(project);
  if ((opts.graph ?? 'auto') === 'off' || adapter === 'mock' || !existsSync(graphJson))
    return undefined;
  const graphify = opts.graphify ?? new Graphify();
  const wiring: GraphWiring = { query: (q) => graphify.query(project, q) };
  log(`graph: ${graphJson}`);
  if (adapter !== 'claude-code') return wiring;
  const listed = org.catalog['graphify-mcp'] !== undefined;
  if (listed && !routed?.attach.includes('graphify-mcp')) return wiring;
  const python = await graphify.pythonPath();
  if (!python) {
    log(
      'warn: graphify python not found (install: uv tool install graphifyy): graph MCP not attached',
    );
    return wiring;
  }
  return { ...wiring, mcpServers: { graphify: graphify.mcpServerConfig(graphJson, python) } };
}

/**
 * For a `worktree` run, the main project and the worktree directory: the workspace is
 * `<project>/.shibaox/worktrees/<runId>[/<subdir>]`.
 */
function worktreeOf(state: RunState): { project: string; path: string } | undefined {
  if (state.workspaceMode !== 'worktree') return undefined;
  const marker = `${sep}.shibaox${sep}worktrees${sep}${state.runId}`;
  const i = state.workspace.lastIndexOf(marker);
  if (i <= 0) return undefined;
  return {
    project: state.workspace.slice(0, i),
    path: state.workspace.slice(0, i + marker.length),
  };
}

/** The main project of a run (not its worktree). */
export function projectOf(state: RunState): string {
  return worktreeOf(state)?.project ?? state.workspace;
}

/** The project's name for vault paths (a safe identifier). */
export function projectName(project: string): string {
  const name = basename(project).replace(/[^A-Za-z0-9._-]/g, '-');
  return name && !name.includes('..') ? name : 'project';
}

function vaultDir(org: Org, opts: EngineOptions): string | undefined {
  if (opts.vault) return resolve(opts.vault);
  return org.org.vault ? resolve(org.root, org.org.vault) : undefined;
}

/** Writes the run note and one decision note per `decide` node once the run is terminal. */
export async function finishRun(
  store: EventStore,
  org: Org,
  state: RunState,
  opts: EngineOptions & { adapter: AdapterId },
): Promise<void> {
  if (!isTerminal(state.status)) return;
  const log = logOf(opts);
  const vault = vaultDir(org, opts);
  if (!vault) {
    log('warn: no vault in org.yaml: run notes are not written');
    return;
  }
  const workflow = state.workflowSnapshot ?? org.workflows[state.workflow];
  if (!workflow) return;
  try {
    const events = await store.read(state.runId);
    const project = projectName(projectOf(state));
    const note = writeRunNote({
      vault,
      project,
      state,
      events,
      workflow,
      adapter: state.adapter ?? opts.adapter,
    });
    log(`note: ${note.path}`);
    for (const [nodeId, node] of Object.entries(workflow.nodes))
      if (node.type === 'decide' && state.nodes[nodeId]?.choice)
        log(`note: ${writeDecisionNote({ vault, project, state, nodeId, events }).path}`);
  } catch (err) {
    log(`warn: vault note not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Where a `worktree` run lives (kept for the user to review and merge), printed at the end. */
export function logWorktree(state: RunState, log: (l: string) => void): void {
  const wt = worktreeOf(state);
  if (wt) log(`worktree: ${wt.path} (branch shibaox/${state.runId})`);
}

/** Path prefix of `project` inside its git repository (`''` at the top level). */
async function gitPrefix(project: string): Promise<string> {
  const r = await runArgv({
    argv: ['git', 'rev-parse', '--show-prefix'],
    cwd: project,
    timeoutMs: 10_000,
  });
  return r.exitCode === 0 ? r.stdout.trim() : '';
}

export async function runWorkflow(workflow: string, opts: RunOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const project = resolve(opts.project);
  assertProjectDir(project);
  const wf = org.workflows[workflow];
  if (!wf) throw new Error(`workflow "${workflow}" is not defined in the org`);
  const adapter = effectiveAdapter(opts.adapter, org);
  const mode: WorkspaceMode =
    opts.workspace ?? ((await isGitRepo(project)) ? 'worktree' : 'inplace');
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const budgetUsd = opts.budget ?? org.org.budgets.per_run_usd;
    const graph = await prepareGraph({
      project,
      org,
      workflow: wf,
      request: opts.input,
      adapter,
      opts,
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
    });
    await finishRun(store, org, state, { ...opts, adapter });
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
