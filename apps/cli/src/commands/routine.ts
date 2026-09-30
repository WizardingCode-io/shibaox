import { resolve } from 'node:path';
import type { RoutineRow, RoutineTrigger } from '@wizardingcode/shibaox-daemon';
import { connect } from '../client.js';
import type { Out } from '../output.js';

export const ON_HELP =
  'cron:<expr> | github:issues|prs|checks | url:<https://…> | file:<path> | command:<shell command>';

/** `--on cron:0 9 * * 1-5`, `--on github:issues`, `--on url:https://…`, `--on file:./x`, `--on command:git fetch`. */
export function parseOn(
  on: string,
  o: { label?: string; repo?: string; branch?: string; project: string },
): RoutineTrigger {
  const i = on.indexOf(':');
  const kind = i < 0 ? on : on.slice(0, i);
  const rest = i < 0 ? '' : on.slice(i + 1).trim();
  switch (kind) {
    case 'cron':
      if (!rest) throw new Error('cron: needs an expression, e.g. --on "cron:0 9 * * 1-5"');
      return { type: 'cron', cron: rest };
    case 'github':
      if (rest !== 'issues' && rest !== 'prs' && rest !== 'checks')
        throw new Error('github: takes issues, prs or checks');
      return {
        type: 'github',
        watch: rest,
        ...(o.repo ? { repo: o.repo } : {}),
        ...(o.label ? { label: o.label } : {}),
        ...(o.branch ? { branch: o.branch } : {}),
      };
    case 'url':
      if (!/^https?:\/\//.test(rest)) throw new Error('url: needs an http(s) URL');
      return { type: 'url', url: rest };
    case 'file':
      if (!rest) throw new Error('file: needs a path');
      return { type: 'file', path: resolve(o.project, rest) };
    case 'command':
      if (!rest) throw new Error('command: needs a shell command');
      return { type: 'command', command: rest };
    default:
      throw new Error(`--on takes ${ON_HELP}`);
  }
}

/** `cron 0 9 * * 1-5`, `github:issues label=bug`, `url https://…`. */
export function describeTrigger(t: RoutineTrigger): string {
  switch (t.type) {
    case 'cron':
      return `cron ${t.cron}`;
    case 'github':
      return `github:${t.watch}${t.repo ? ` ${t.repo}` : ''}${t.label ? ` label=${t.label}` : ''}${t.branch ? ` branch=${t.branch}` : ''}`;
    case 'url':
      return `url ${t.url}`;
    case 'file':
      return `file ${t.path}`;
    case 'command':
      return `command ${t.command}`;
  }
}

const line = (r: RoutineRow) =>
  `${r.id}  ${(r.name ?? '').padEnd(14).slice(0, 14)} ${describeTrigger(r.trigger).padEnd(34).slice(0, 34)} ${r.workflow.padEnd(16)} ${r.enabled ? 'on ' : 'off'}${r.lastRunId ? `  last run ${r.lastRunId.slice(0, 8)}` : ''}${r.source === 'org' ? '  (org)' : ''}`;

export async function routineAdd(
  workflow: string,
  o: {
    on: string;
    org: string;
    project: string;
    input?: string;
    name?: string;
    adapter?: string;
    budget?: number;
    maxDaily?: number;
    every?: number;
    mode?: string;
    label?: string;
    repo?: string;
    branch?: string;
  },
  out: Out,
): Promise<number> {
  const project = resolve(o.project);
  let trigger: RoutineTrigger;
  try {
    trigger = parseOn(o.on, { label: o.label, repo: o.repo, branch: o.branch, project });
  } catch (e) {
    out.line(e instanceof Error ? e.message : String(e));
    out.obj({ added: false, error: e instanceof Error ? e.message : String(e) });
    return 1;
  }
  if (o.mode && o.mode !== 'always' && o.mode !== 'on_change') {
    out.line('--mode takes always or on_change');
    return 1;
  }
  const client = await connect({ write: true });
  const row = await client.addRoutine({
    trigger,
    orgRoot: resolve(o.org),
    project,
    workflow,
    input: o.input ?? '',
    name: o.name,
    adapter: o.adapter,
    budgetUsd: o.budget,
    maxDailyUsd: o.maxDaily,
    intervalS: o.every,
    mode: o.mode as 'always' | 'on_change' | undefined,
  });
  out.line(
    `Added routine ${row.id}: ${describeTrigger(row.trigger)} → ${row.workflow} (${row.project})`,
  );
  out.obj(row);
  return 0;
}

export async function routineList(out: Out): Promise<number> {
  const client = await connect();
  const rows = await client.routines();
  if (rows.length === 0)
    out.line(
      'No routines. Add one: shibaox routine add <workflow> --on "cron:0 9 * * 1-5" --org ./org --project .',
    );
  for (const r of rows) {
    out.line(line(r));
    out.obj(r);
  }
  return 0;
}

export async function routineShow(id: string, out: Out): Promise<number> {
  const client = await connect();
  const r = await client.routine(id);
  out.line(
    `${r.id}${r.name ? ` · ${r.name}` : ''}${r.source === 'org' ? ' · from org/routines' : ''}`,
  );
  out.line(
    `trigger: ${describeTrigger(r.trigger)}${r.trigger.type === 'cron' ? '' : ` · every ${r.intervalS}s · ${r.mode}`}`,
  );
  out.line(`workflow: ${r.workflow} · project: ${r.project} · org: ${r.orgRoot}`);
  if (r.input) out.line(`input: ${r.input.split('\n')[0]}`);
  out.line(
    `${r.enabled ? 'enabled' : 'paused'}${r.adapter ? ` · adapter ${r.adapter}` : ''}${r.budgetUsd !== undefined ? ` · budget $${r.budgetUsd}` : ''}${r.maxDailyUsd !== undefined ? ` · max $${r.maxDailyUsd}/day` : ''}`,
  );
  if (r.lastFiredAt)
    out.line(`last fired: ${r.lastFiredAt}${r.lastRunId ? ` (run ${r.lastRunId})` : ''}`);
  if (r.lastCheckedAt) out.line(`last looked: ${r.lastCheckedAt}`);
  out.obj(r);
  return 0;
}

export async function routineRemove(id: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  await client.removeRoutine(id);
  out.line(`Removed routine ${id}`);
  out.obj({ id, removed: true });
  return 0;
}

export async function routineRun(id: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const r = await client.runRoutine(id);
  out.line(`Routine ${id} submitted run ${r.runId}`);
  out.obj({ id, ...r });
  return 0;
}

export async function routinePause(id: string, resume: boolean, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const r = resume ? await client.resumeRoutine(id) : await client.pauseRoutine(id);
  out.line(`Routine ${id} ${resume ? 'resumed' : 'paused'}`);
  out.obj(r);
  return 0;
}

/** `shibaox routine sync --org ./org`: `org/routines/*.yaml` become the org's routines. */
export async function routineSync(o: { org: string }, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const r = await client.syncRoutines(resolve(o.org));
  const parts = [
    ...r.added.map((id) => `added ${id}`),
    ...r.updated.map((id) => `updated ${id}`),
    ...r.removed.map((id) => `removed ${id}`),
  ];
  out.line(parts.length ? parts.join(', ') : 'Nothing changed.');
  out.obj(r);
  return 0;
}
