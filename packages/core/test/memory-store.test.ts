import { describe, expect, it } from 'vitest';
import { MemoryEventStore } from '../src/index.js';

const at = '2026-09-25T10:00:00.000Z';

describe('MemoryEventStore', () => {
  it('assigns increasing seq and isolates runs', async () => {
    const store = new MemoryEventStore();
    await store.append({
      type: 'RunCreated',
      runId: 'a',
      at,
      workflow: 'w',
      input: {},
      workspace: '/w',
    });
    await store.append({
      type: 'RunCreated',
      runId: 'b',
      at,
      workflow: 'w',
      input: {},
      workspace: '/w',
    });
    const e = await store.append({ type: 'RunCompleted', runId: 'a', at });
    expect(e.seq).toBe(3);
    expect((await store.read('a')).map((x) => x.type)).toEqual(['RunCreated', 'RunCompleted']);
    const runs = await store.listRuns();
    expect(runs.find((r) => r.runId === 'a')?.status).toBe('completed');
    expect(runs.find((r) => r.runId === 'b')?.status).toBe('running');
  });

  it('validates events on append like the SQLite store', async () => {
    const store = new MemoryEventStore();
    await expect(store.append({ type: 'RunCompleted', runId: 'a' } as never)).rejects.toThrow();
    await expect(store.append({ type: 'NoSuchEvent', runId: 'a', at } as never)).rejects.toThrow();
    expect(await store.read('a')).toEqual([]);
  });
});
