import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type EventStore,
  type HumanHandler,
  MockAdapter,
  RunEngine,
  type RunState,
  ScriptedDecider,
} from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { loadOrg, type Org } from '@shibaox/schemas';
import { TerminalHuman } from '../terminal-human.js';

export interface EngineOptions {
  adapter?: 'mock';
  human?: HumanHandler;
  log?: (line: string) => void;
}

export interface RunOptions extends EngineOptions {
  org: string;
  project: string;
  input: string;
  adapter: 'mock';
  budget?: number;
  db?: string;
}

export function dbPath(orgDir: string, override?: string): string {
  const path = override ?? join(orgDir, '.shibaox', 'events.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
}

/** The engine shared by `run` and `resume`: mock adapter, scripted decider, terminal human. */
export function buildEngine(store: EventStore, org: Org, opts: EngineOptions): RunEngine {
  return new RunEngine({
    store,
    org,
    adapters: {
      mock: new MockAdapter((j) => ({
        output: { instruction: j.instruction },
        summary: `mock ${j.role.role}: ${j.instruction}`,
        cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 },
      })),
    },
    defaultAdapter: opts.adapter ?? 'mock',
    decider: new ScriptedDecider({}, 'ship'),
    human: opts.human ?? new TerminalHuman(),
    log: opts.log ?? ((l) => console.log(l)),
  });
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
    return await buildEngine(store, org, opts).start({
      workflow,
      input: { spec: opts.input },
      workspace,
      budgetUsd: opts.budget ?? org.org.budgets.per_run_usd,
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
