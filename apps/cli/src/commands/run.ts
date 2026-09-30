import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isTerminal, type RunStatus, runArgv } from '@wizardingcode/shibaox-core';
import type { AdapterId, GraphMode } from '@wizardingcode/shibaox-daemon';
import { homePaths } from '@wizardingcode/shibaox-daemon';
import type { WorkspaceMode } from '@wizardingcode/shibaox-workspace';
import { connect } from '../client.js';
import { exitCodeFor, formatState, type Out } from '../output.js';
import { followRun } from './follow.js';
import { bunAvailable, daemonArgs, daemonEnv, spawnTui, TUI_ENTRY } from './ui.js';

export interface RunCommandOptions {
  /** Absent: `./org` when it exists, else the daemon's default org. */
  org?: string;
  project: string;
  input?: string;
  adapter?: AdapterId;
  workspace?: WorkspaceMode;
  graph?: GraphMode;
  budget?: number;
  /** A model ref (`provider/model`) for every task of the run. */
  model?: string;
  /** Worktree dependency install: auto (default), off, or a command. */
  setup?: string;
  /** A GitHub issue number (or URL): its title and body become the request, its repo the origin. */
  issue?: string;
  detach?: boolean;
}

/** `gh issue view` of the project's repository: the request text and the origin of the run. */
export async function issueRequest(
  issue: string,
  project: string,
  exec: typeof runArgv = runArgv,
): Promise<{ input: string; origin: string }> {
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/.exec(issue);
  const number = url ? (url[2] as string) : issue.replace(/^#/, '');
  if (!/^\d+$/.test(number))
    throw new Error(`--issue takes a number or an issue URL, got ${issue}`);
  // a URL names the repository: read it from here; a bare number needs the project checkout,
  // which on a remote daemon is not on this machine
  if (!url && !existsSync(project))
    throw new Error(
      `--issue ${number}: the project ${project} is not on this machine (a remote daemon?): give the issue URL instead`,
    );
  const repoArgs = url ? ['--repo', url[1] as string] : [];
  const r = await exec({
    argv: ['gh', 'issue', 'view', number, ...repoArgs, '--json', 'number,title,body,url,labels'],
    cwd: url ? process.cwd() : project,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0)
    throw new Error(
      `gh issue view ${number} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`,
    );
  const v = JSON.parse(r.stdout) as {
    number: number;
    title: string;
    body?: string;
    url: string;
    labels?: { name: string }[];
  };
  const repo = /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(v.url)?.[1];
  if (!repo) throw new Error(`could not tell the repository from ${v.url}`);
  const labels = v.labels?.map((l) => l.name).filter(Boolean) ?? [];
  const input = [
    `Issue #${v.number}: ${v.title}`,
    v.url,
    ...(labels.length ? [`Labels: ${labels.join(', ')}`] : []),
    '',
    (v.body ?? '').trim() || '(no description)',
  ].join('\n');
  return { input, origin: `github:${repo}#${v.number}` };
}

/** `--org`, else `./org` when it holds an org, else the daemon's default org. */
export async function resolveOrg(
  client: { defaultOrg(): Promise<{ root: string }> },
  org: string | undefined,
): Promise<string> {
  if (org) return resolve(org);
  const local = resolve('org');
  if (existsSync(join(local, 'org.yaml'))) return local;
  return (await client.defaultOrg()).root;
}

/** `shibaox run`: submits to the daemon and, unless detached, follows the stream. */
export async function runCommand(
  workflow: string,
  o: RunCommandOptions,
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const orgRoot = await resolveOrg(client, o.org);
  const project = resolve(o.project);
  let input = o.input;
  let origin: string | undefined;
  if (o.issue) {
    const fromIssue = await issueRequest(o.issue, project);
    input = o.input ? `${fromIssue.input}\n\n${o.input}` : fromIssue.input;
    origin = fromIssue.origin;
  }
  const { runId, warnings } = await client.submitRun({
    orgRoot,
    project,
    workflow,
    input: input ?? '',
    adapter: o.adapter,
    workspace: o.workspace,
    budgetUsd: o.budget,
    graph: o.graph,
    model: o.model,
    setup: o.setup,
    origin,
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
  spawnTui: (args: string[], env?: Record<string, string>) => Promise<number>;
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
    const code = await deps.spawnTui(
      ['stream', runId, ...daemonArgs(paths), '--home', paths.root],
      daemonEnv(),
    );
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
    const { SqliteEventStore } = await import('@wizardingcode/shibaox-persistence-sqlite');
    const { replay } = await import('@wizardingcode/shibaox-core');
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

/** `shibaox steer <runId> <note…>`: the running task stops and starts again with the note. */
export async function steerCommand(
  runId: string,
  words: string[],
  o: { node?: string },
  out: Out,
): Promise<number> {
  const note = words.join(' ').trim();
  if (!note) {
    out.line('Say what: shibaox steer <runId> "use pnpm, not npm"');
    return 1;
  }
  const client = await connect({ write: true });
  const state = await client.steer(runId, { nodeId: o.node, note, via: 'cli' });
  const steered = Object.entries(state.nodes).find(([, n]) => n.steering?.at(-1)?.note === note);
  out.line(
    `Steered ${steered?.[0] ?? 'the task'} of run ${runId.slice(0, 8)}: it starts again with your note.`,
  );
  out.obj({ runId, nodeId: steered?.[0], note });
  return 0;
}

/** `30d`, `12h`, `45m`, or an ISO date: the moment before which finished runs are removed. */
export function parseBefore(v: string, now: Date = new Date()): string | undefined {
  const m = v.match(/^(\d+)([dhm])$/);
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'd' ? n * 86_400_000 : m[2] === 'h' ? n * 3_600_000 : n * 60_000;
    return new Date(now.getTime() - ms).toISOString();
  }
  return Number.isNaN(Date.parse(v)) ? undefined : new Date(v).toISOString();
}

/** `shibaox runs prune --before 30d`: finished runs older than that go, with their events. */
export async function runsPruneCommand(o: { before?: string }, out: Out): Promise<number> {
  const before = o.before ? parseBefore(o.before) : undefined;
  if (!before) {
    out.line('Say how old: shibaox runs prune --before 30d (or 12h, 45m, or an ISO date).');
    out.obj({ removed: [], error: 'bad --before' });
    return 1;
  }
  const client = await connect({ write: true });
  const { removed } = await client.pruneRuns(before);
  out.line(
    removed.length === 0
      ? `Nothing to remove: no finished run older than ${before}.`
      : `Removed ${removed.length} run(s) finished before ${before}.`,
  );
  out.obj({ removed, before });
  return 0;
}

/** `shibaox audit <runId>`: everything that happened in a run, as Markdown (or JSON), to stdout or a file. */
export async function auditCommand(
  runId: string,
  o: { format?: string; out?: string },
  out: Out,
): Promise<number> {
  const client = await connect();
  const format = o.format ?? (out.json ? 'json' : 'md');
  if (format !== 'md' && format !== 'json') {
    out.line('--format takes md or json');
    return 1;
  }
  const text =
    format === 'md'
      ? await client.auditMarkdown(runId)
      : `${JSON.stringify(await client.audit(runId), null, 2)}\n`;
  if (o.out) {
    writeFileSync(o.out, text);
    out.line(`Wrote the audit of ${runId} to ${o.out}`);
    out.obj({ runId, file: o.out, format });
    return 0;
  }
  process.stdout.write(text);
  return 0;
}
