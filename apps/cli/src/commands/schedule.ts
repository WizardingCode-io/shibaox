import { resolve } from 'node:path';
import { connect } from '../client.js';
import type { Out } from '../output.js';

export async function scheduleAdd(
  cron: string,
  workflow: string,
  o: { org: string; project: string; input?: string; adapter?: string; budget?: number },
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const row = await client.addSchedule({
    cron,
    orgRoot: resolve(o.org),
    project: resolve(o.project),
    workflow,
    input: o.input ?? '',
    adapter: o.adapter,
    budgetUsd: o.budget,
  });
  out.line(`Added schedule ${row.id}: "${row.cron}" ${row.workflow} (${row.project})`);
  out.obj(row);
  return 0;
}

export async function scheduleList(out: Out): Promise<number> {
  const client = await connect();
  const rows = await client.schedules();
  if (rows.length === 0) out.line('No schedules.');
  for (const r of rows) {
    out.line(
      `${r.id}  ${r.cron.padEnd(16)} ${r.workflow.padEnd(20)} ${r.enabled ? 'on ' : 'off'}  ${r.project}${r.lastRunId ? `  last run ${r.lastRunId.slice(0, 8)}` : ''}`,
    );
    out.obj(r);
  }
  return 0;
}

export async function scheduleRemove(id: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  await client.removeSchedule(id);
  out.line(`Removed schedule ${id}`);
  out.obj({ id, removed: true });
  return 0;
}

export async function scheduleRun(id: string, out: Out): Promise<number> {
  const client = await connect({ write: true });
  const r = await client.runSchedule(id);
  out.line(`Schedule ${id} submitted run ${r.runId}`);
  out.obj({ id, ...r });
  return 0;
}
