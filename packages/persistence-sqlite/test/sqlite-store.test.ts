import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';

describe('SqliteEventStore', () => {
  it('persists events across instances and preserves order', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sx-')), 'events.db');
    const a = new SqliteEventStore(file);
    await a.append({
      type: 'RunCreated',
      runId: 'r1',
      at,
      workflow: 'w',
      input: { k: 1 },
      workspace: '/w',
    });
    await a.append({ type: 'NodeStarted', runId: 'r1', nodeId: 'a', at });
    a.close();
    const b = new SqliteEventStore(file);
    const events = await b.read('r1');
    expect(events.map((e) => [e.seq, e.type])).toEqual([
      [1, 'RunCreated'],
      [2, 'NodeStarted'],
    ]);
    expect(events[0]).toMatchObject({ input: { k: 1 } });
    const runs = await b.listRuns();
    expect(runs).toEqual([
      { runId: 'r1', workflow: 'w', status: 'running', createdAt: at, updatedAt: at },
    ]);
    b.close();
  });
  it('rejects an event that does not match the schema', async () => {
    const s = new SqliteEventStore(':memory:');
    // @ts-expect-error deliberately malformed
    await expect(s.append({ type: 'Nope', runId: 'x', at })).rejects.toThrow();
  });
  it('returns an empty list for an unknown run', async () => {
    const s = new SqliteEventStore(':memory:');
    expect(await s.read('missing')).toEqual([]);
  });
});
