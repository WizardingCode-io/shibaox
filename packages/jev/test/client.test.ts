import { choice, noul, score } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { gateByConfidence, JevClient } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

describe('JevClient.fanOut', () => {
  it('sends state and questions in one call and maps usage to cost', async () => {
    fake = await startFakeJev(() => ({
      team: {
        type: 'choice',
        choice: 'engineering',
        confidence: 0.93,
        probabilities: { engineering: 0.93, marketing: 0.07 },
      },
      urgent: { type: 'noul', noul: 0.2 },
      quality: {
        type: 'score',
        score: 2,
        confidence: 0.8,
        legend: ['bad', 'ok', 'good'],
        probabilities: [0.1, 0.1, 0.8],
      },
    }));
    const client = new JevClient({ apiKey: 'k', baseURL: fake.baseURL });
    const r = await client.fanOut('Fix the payments bug', {
      team: choice('Which team', { engineering: 'code', marketing: 'campaigns' }),
      urgent: noul('The request is urgent'),
      quality: score('Quality', ['bad', 'ok', 'good']),
    });
    expect(r.answers.team.choice).toBe('engineering');
    expect(r.answers.urgent.noul).toBeCloseTo(0.2);
    expect(r.answers.quality.score).toBe(2);
    expect(fake.requests).toHaveLength(1);
    expect(r.cost).toBeCloseTo((r.usage.inputTokens / 1_000_000) * 0.042);
  });
  it('isConfigured reflects the api key', () => {
    expect(new JevClient({ apiKey: undefined, baseURL: 'http://x' }).isConfigured()).toBe(false);
  });
});

describe('gateByConfidence', () => {
  it('passes above threshold, escalates in the grey zone, fails below', () => {
    expect(gateByConfidence(0.9, 0.8)).toBe('pass');
    expect(gateByConfidence(0.6, 0.8)).toBe('escalate');
    expect(gateByConfidence(0.3, 0.8)).toBe('fail');
  });
});
