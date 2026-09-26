import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { EventStore, HumanHandler, RunEngine, RunState } from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import { loadOrg, type Org, type Workflow } from '@shibaox/schemas';
import { TerminalHuman } from '../terminal-human.js';
import { type AdapterId, buildRuntime } from '../wiring.js';

export interface EngineOptions {
  /** Runtime adapter; when omitted, `adapter:` in org.yaml, else `mock`. */
  adapter?: AdapterId;
  human?: HumanHandler;
  log?: (line: string) => void;
  /** Environment for provider keys and Jev (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Providers added to the built-in catalog. */
  extraProviders?: ProviderEntry[];
}

export interface RunOptions extends EngineOptions {
  org: string;
  project: string;
  input: string;
  budget?: number;
  db?: string;
}

export function dbPath(orgDir: string, override?: string): string {
  const path = override ?? join(orgDir, '.shibaox', 'events.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
}

/**
 * The engine shared by `run` and `resume`, built by `buildRuntime`; prints its
 * warnings. Throws `cannot start: ...` (before any event is written) when the
 * direct adapter cannot resolve a task role of `run.workflow`.
 */
export function buildEngine(
  store: EventStore,
  org: Org,
  opts: EngineOptions,
  run: { workflow?: Workflow; budgetUsd?: number } = {},
): RunEngine {
  const log = opts.log ?? ((l: string) => console.log(l));
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
  });
  for (const w of warnings) log(`warn: ${w}`);
  return engine;
}

function assertProjectDir(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`project path not found: ${path}`);
}

export async function runWorkflow(workflow: string, opts: RunOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const workspace = resolve(opts.project);
  assertProjectDir(workspace);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const budgetUsd = opts.budget ?? org.org.budgets.per_run_usd;
    return await buildEngine(store, org, opts, {
      workflow: org.workflows[workflow],
      budgetUsd,
    }).start({
      workflow,
      input: { spec: opts.input },
      workspace,
      budgetUsd,
    });
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
