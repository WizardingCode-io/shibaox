import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTerminal, type RunStatus } from '@shibaox/core';
import type { AdapterId, GraphMode } from '@shibaox/daemon';
import { homePaths } from '@shibaox/daemon';
import type { WorkspaceMode } from '@shibaox/workspace';
import { connect } from '../client.js';
import { exitCodeFor, formatState, type Out } from '../output.js';
import { followRun } from './follow.js';
import { bunAvailable, spawnTui, TUI_ENTRY } from './ui.js';

export interface RunCommandOptions {
  org: string;
  project: string;
  input: string;
  adapter?: AdapterId;
  workspace?: WorkspaceMode;
  graph?: GraphMode;
  budget?: number;
  /** A model ref (`provider/model`) for every task of the run. */
  model?: string;
  detach?: boolean;
}

/** `shibaox run`: submits to the daemon and, unless detached, follows the stream. */
export async function runCommand(
  workflow: string,
  o: RunCommandOptions,
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const { runId, warnings } = await client.submitRun({
    orgRoot: resolve(o.org),
    project: resolve(o.project),
    workflow,
    input: o.input,
    adapter: o.adapter,
    workspace: o.workspace,
    budgetUsd: o.budget,
    graph: o.graph,
    model: o.model,
  });
  for (const w of warnings) out.line(`warn: ${w}`);
  out.line(`run ${runId} queued`);
  out.obj({ runId, warnings });
  if (o.detach) return 0;
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  try {
    return await followAny(client, runId, { signal: ac.signal }, out);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export interface FollowDeps {
  tty: boolean;
  bunAvailable: () => Promise<boolean>;
  spawnTui: (args: string[]) => Promise<number>;
}

const defaultDeps = (): FollowDeps => ({
  tty: Boolean(process.stdout.isTTY && process.stdin.isTTY && existsSync(TUI_ENTRY)),
  bunAvailable,
  spawnTui,
});

/**
 * The OpenTUI stream (under Bun) in an interactive terminal, followed by the run's final
 * state once it ended; the plain text stream otherwise, with --json, or without Bun.
 */
export async function followAny(
  client: Parameters<typeof followRun>[0],
  runId: string,
  o: { since?: string; signal?: AbortSignal },
  out: Out,
  deps: FollowDeps = defaultDeps(),
): Promise<number> {
  if (!out.json && deps.tty && (await deps.bunAvailable())) {
    // an unknown run is refused here, with the same error as the text path
    await client.getRun(runId);
    const paths = homePaths();
    const code = await deps.spawnTui([
      'stream',
      runId,
      '--socket',
      paths.socket,
      '--home',
      paths.root,
    ]);
    const state = await client.getRun(runId);
    if (isTerminal(state.status as RunStatus)) for (const l of formatState(state)) out.line(l);
    return code;
  }
  return followRun(client, runId, o, out);
}

export async function resumeCommand(
  runId: string,
  o: { budget?: number },
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const state = await client.resume(runId, { budgetUsd: o.budget });
  out.line(`run ${runId} resumed (${state.status})`);
  out.obj({ runId, status: state.status });
  return followAny(client, runId, {}, out);
}

export async function cancelCommand(runId: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const state = await client.cancel(runId);
  out.line(`run ${runId} ${state.status}`);
  out.obj({ runId, status: state.status });
  return 0;
}

export async function runsCommand(o: { status?: string; org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const runs = await client.listRuns({ status: o.status, org: o.org ? resolve(o.org) : undefined });
  if (runs.length === 0) out.line('No runs yet.');
  for (const r of runs) {
    out.line(
      `${r.runId}  ${r.workflow.padEnd(20)} ${r.status.padEnd(16)} $${r.spentUsd.toFixed(4)}  ${r.updatedAt}`,
    );
    out.obj(r);
  }
  return 0;
}

export async function replayCommand(runId: string, o: { db?: string }, out: Out): Promise<number> {
  if (o.db) {
    const { SqliteEventStore } = await import('@shibaox/persistence-sqlite');
    const { replay } = await import('@shibaox/core');
    const store = new SqliteEventStore(resolve(o.db));
    try {
      const events = await store.read(runId);
      if (events.length === 0) throw new Error(`run ${runId} not found in ${o.db}`);
      for (const e of events) {
        out.line(
          `${String(e.seq).padStart(4)}  ${e.at}  ${e.type}${'nodeId' in e ? ` ${e.nodeId}` : ''}`,
        );
        out.obj(e);
      }
      const state = replay(events);
      for (const l of formatState(state)) out.line(l);
      out.obj({ final: state });
      return exitCodeFor(state.status);
    } finally {
      store.close();
    }
  }
  const client = await connect();
  let seq = 0;
  for await (const e of client.events(runId, { historyOnly: true })) {
    if (e.kind !== 'run') continue;
    seq++;
    out.line(
      `${String(seq).padStart(4)}  ${e.event.at}  ${e.event.type}${'nodeId' in e.event ? ` ${e.event.nodeId}` : ''}`,
    );
    out.obj(e.event);
  }
  const state = await client.getRun(runId);
  for (const l of formatState(state)) out.line(l);
  out.obj({ final: state });
  return 0;
}
