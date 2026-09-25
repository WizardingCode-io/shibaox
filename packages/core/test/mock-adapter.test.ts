import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { collectRun, MockAdapter, type TaskJob } from '../src/index.js';

const job: TaskJob = {
  runId: 'r',
  nodeId: 'a',
  role: RoleSchema.parse({ role: 'backend' }),
  instruction: 'do it',
  input: { spec: 's' },
  workspace: '/w',
  context: { previousOutputs: {} },
};
const ctx = { signal: new AbortController().signal, log: () => {} };

describe('MockAdapter', () => {
  it('yields started then result and collectRun returns the result', async () => {
    const adapter = new MockAdapter((j) => ({
      output: { echoed: j.instruction },
      summary: 'mocked',
      cost: { usd: 0.01, inputTokens: 1, outputTokens: 1 },
    }));
    const events: string[] = [];
    for await (const e of adapter.run(job, ctx)) events.push(e.type);
    expect(events).toEqual(['started', 'result']);
    expect(await collectRun(adapter, job, ctx)).toEqual({
      output: { echoed: 'do it' },
      summary: 'mocked',
      cost: { usd: 0.01, inputTokens: 1, outputTokens: 1 },
    });
  });
  it('collectRun throws on an error event', async () => {
    const adapter = new MockAdapter(() => {
      throw new Error('nope');
    });
    await expect(collectRun(adapter, job, ctx)).rejects.toThrow('nope');
  });
});
