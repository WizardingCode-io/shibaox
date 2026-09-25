import { afterEach, describe, expect, it } from 'vitest';
import { JevClient, JevDecider } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => {
  await fake?.close();
});
const req = {
  runId: 'r',
  nodeId: 'judge',
  by: 'team-leader',
  question: 'Ready to ship?',
  options: ['ship', 'rework'],
  context: { input: { spec: 'x' }, previousOutputs: { implement: { did: 'it' } } },
};

describe('JevDecider', () => {
  it('returns the Jev choice with confidence and cost', async () => {
    fake = await startFakeJev(() => ({
      decision: {
        type: 'choice',
        choice: 'ship',
        confidence: 0.91,
        probabilities: { ship: 0.91, rework: 0.09 },
      },
    }));
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await d.decide(req);
    expect(r).toMatchObject({ choice: 'ship', confidence: 0.91 });
    expect(r.cost?.usd).toBeGreaterThan(0);
    const sent = fake.requests[0] as {
      questions: { decision: { criteria: Record<string, string> } };
    };
    expect(Object.keys(sent.questions.decision.criteria)).toEqual(['ship', 'rework']);
  });
  it('falls back to another decider when confidence is below the threshold', async () => {
    fake = await startFakeJev(() => ({
      decision: {
        type: 'choice',
        choice: 'ship',
        confidence: 0.55,
        probabilities: { ship: 0.55, rework: 0.45 },
      },
    }));
    const fallback = { decide: async () => ({ choice: 'rework', confidence: 1 }) };
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), {
      threshold: 0.8,
      fallback,
    });
    expect((await d.decide(req)).choice).toBe('rework');
  });
  it('without a fallback, low confidence still returns the Jev choice but flags it', async () => {
    fake = await startFakeJev(() => ({
      decision: {
        type: 'choice',
        choice: 'ship',
        confidence: 0.55,
        probabilities: { ship: 0.55, rework: 0.45 },
      },
    }));
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), {
      threshold: 0.8,
    });
    const r = await d.decide(req);
    expect(r.choice).toBe('ship');
    expect(r.confidence).toBe(0.55);
  });
});
