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
    expect(r).toMatchObject({ choice: 'ship', confidence: 0.91, by: 'jev' });
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
    const fallback = {
      decide: async () => ({
        choice: 'rework',
        confidence: 1,
        by: 'fallback',
        cost: { usd: 0.5, inputTokens: 100, outputTokens: 10 },
      }),
    };
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), {
      threshold: 0.8,
      fallback,
    });
    const r = await d.decide(req);
    expect(r.choice).toBe('rework');
    expect(r.by).toBe('fallback');
    const jevInputTokens = Math.max(1, Math.ceil(JSON.stringify(fake.requests[0]).length / 4));
    expect(r.cost?.inputTokens).toBe(100 + jevInputTokens);
    expect(r.cost?.outputTokens).toBe(10);
  });
  it('without a fallback, low confidence throws instead of returning a flagged choice', async () => {
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
    await expect(d.decide(req)).rejects.toThrow(
      'jev decision below confidence threshold (0.55 < 0.8) and no fallback decider configured',
    );
  });
  it('sends state with spec and output sections built from the question/input/previousOutputs', async () => {
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
    await expect(d.decide(req)).rejects.toThrow(/no fallback decider/);
    const sent = fake.requests[0] as { state: string };
    expect(sent.state).toContain('## spec');
    expect(sent.state).toContain(req.question);
    expect(sent.state).toContain('## output');
    expect(sent.state).toContain('did');
  });
});
