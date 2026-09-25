import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type HumanHandler,
  MockAdapter,
  RunEngine,
  type RunState,
  ScriptedDecider,
} from '@shibaox/core';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import { loadOrg } from '@shibaox/schemas';
import { TerminalHuman } from '../terminal-human.js';

export interface RunOptions {
  org: string;
  project: string;
  input: string;
  adapter: 'mock';
  budget?: number;
  db?: string;
  human?: HumanHandler;
  log?: (line: string) => void;
}

export function dbPath(orgDir: string, override?: string): string {
  const path = override ?? join(orgDir, '.shibaox', 'events.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return path;
}

export async function runWorkflow(workflow: string, opts: RunOptions): Promise<RunState> {
  const orgDir = resolve(opts.org);
  const org = loadOrg(orgDir);
  const store = new SqliteEventStore(dbPath(orgDir, opts.db));
  try {
    const engine = new RunEngine({
      store,
      org,
      adapters: {
        mock: new MockAdapter((j) => ({
          output: { instruction: j.instruction },
          summary: `mock ${j.role.role}: ${j.instruction}`,
          cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 },
        })),
      },
      defaultAdapter: opts.adapter,
      decider: new ScriptedDecider({}, 'ship'),
      human: opts.human ?? new TerminalHuman(),
      log: opts.log ?? ((l) => console.log(l)),
    });
    return await engine.start({
      workflow,
      input: { spec: opts.input },
      workspace: resolve(opts.project),
      budgetUsd: opts.budget,
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
      `  ${id.padEnd(22)} ${n.status.padEnd(10)} attempts=${n.attempts}${n.choice ? ` choice=${n.choice}` : ''}${n.error ? ` error=${n.error}` : ''}`,
    );
  if (state.error) console.log(`  error: ${state.error}`);
  if (state.pendingHuman)
    console.log(
      `  waiting for human at ${state.pendingHuman.nodeId}: ${state.pendingHuman.prompt}`,
    );
}
