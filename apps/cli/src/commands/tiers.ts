import type { OrgConfigPatch } from '@wizardingcode/shibaox-daemon';
import { connect } from '../client.js';
import type { Out } from '../output.js';
import { resolveOrg } from './run.js';

const SETTABLE = ['strong', 'cheap', 'decision', 'judge', 'adapter', 'budget'] as const;

/** `shibaox tiers`: the org's tiers, judge, adapter and budget. */
export async function tiersList(o: { org?: string }, out: Out): Promise<number> {
  const client = await connect();
  const root = await resolveOrg(client, o.org);
  const c = await client.orgConfig(root);
  out.line(`org ${c.organization} (${root})`);
  const rows = [
    { name: 'strong', value: c.tiers.strong, note: 'tasks that need the best model' },
    { name: 'cheap', value: c.tiers.cheap, note: 'the orchestrator and light roles' },
    {
      name: 'decision',
      value: c.tiers.decision,
      note: 'decide nodes (a model ref, or jev-latest with TYPESAFE_API_KEY)',
    },
    { name: 'judge', value: c.judge, note: 'judge checks (default: decision, then strong)' },
    {
      name: 'adapter',
      value: c.adapter,
      note: 'default runtime (mock, direct, claude-code); a chosen model overrides it',
    },
    {
      name: 'budget',
      value: c.per_run_usd === undefined ? undefined : String(c.per_run_usd),
      note: 'USD per run',
    },
  ];
  for (const r of rows) {
    out.line(`${r.name.padEnd(10)} ${(r.value ?? '—').padEnd(44)} ${r.note}`);
    out.obj(r);
  }
  out.line('');
  out.line(
    'Change one with: shibaox tiers set <strong|cheap|decision|judge|adapter|budget> <value>   ("none" clears judge/adapter; a budget of "—" means no spend limit)',
  );
  return 0;
}

export async function tiersSet(
  name: string,
  value: string,
  o: { org?: string },
  out: Out,
): Promise<number> {
  if (!(SETTABLE as readonly string[]).includes(name)) {
    out.line(`Unknown setting "${name}": use one of ${SETTABLE.join(', ')}`);
    out.obj({ name, set: false });
    return 1;
  }
  const clear = value === 'none';
  if (clear && (name === 'budget' || !(name === 'judge' || name === 'adapter'))) {
    out.line(
      name === 'budget'
        ? 'A budget cannot be cleared here: set a positive amount (runs without one have no spend limit).'
        : `Tier ${name} cannot be cleared: pick another model.`,
    );
    out.obj({ name, set: false });
    return 1;
  }
  const budget = name === 'budget' ? Number(value) : undefined;
  if (budget !== undefined && !(Number.isFinite(budget) && budget > 0)) {
    out.line(`Budget must be a positive number in USD, got "${value}".`);
    out.obj({ name, set: false });
    return 1;
  }
  const client = await connect({ write: true });
  const root = await resolveOrg(client, o.org);
  const patch: OrgConfigPatch =
    name === 'judge'
      ? { judge: clear ? null : value }
      : name === 'adapter'
        ? { adapter: clear ? null : (value as OrgConfigPatch['adapter']) }
        : name === 'budget'
          ? { per_run_usd: budget }
          : { tiers: { [name]: clear ? null : value } };
  const c = await client.setOrgConfig(root, patch);
  out.line(`${name} set for org ${c.organization}.`);
  out.obj({ name, set: true, config: c });
  return 0;
}
