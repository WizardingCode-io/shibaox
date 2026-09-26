import { connect } from '../client.js';
import type { Out } from '../output.js';

export async function inboxCommand(out: Out): Promise<number> {
  const client = await connect();
  const items = await client.inbox();
  if (items.length === 0) out.line('Nothing waiting for you.');
  for (const i of items) {
    const what =
      i.kind === 'approval'
        ? `${i.detail.category ?? 'approval'} by ${i.detail.role ?? 'a role'}: ${i.prompt}`
        : i.prompt;
    out.line(`${i.id}\n  run ${i.runId.slice(0, 8)} · node ${i.nodeId} · ${i.at}\n  ${what}`);
    out.obj(i);
  }
  if (items.length > 0)
    out.line('\nAnswer with: shibaox approve <id> [--note ...] or shibaox deny <id>');
  return 0;
}

export async function answerCommand(
  id: string,
  approved: boolean,
  o: { note?: string },
  out: Out,
): Promise<number> {
  const client = await connect({ write: true });
  const r = await client.answer(id, { approved, note: o.note, via: 'cli' });
  out.line(`${approved ? 'Approved' : 'Denied'} ${id} (run ${r.runId.slice(0, 8)})`);
  out.obj({ id, approved, runId: r.runId, kind: r.kind });
  return 0;
}
