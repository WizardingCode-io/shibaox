import type { Questions } from '@typesafe-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_MAX_CHARS,
  type RouteFanOut,
  routeHint,
  routeRequest,
  STATE_MAX_CHARS,
} from '../src/router.js';

type Sent = { state: string; questions: Questions };

/** A fake `fanOut`: records what it got, answers with `answers` (and a fixed usage). */
function fake(answers: Record<string, unknown>) {
  const sent: Sent[] = [];
  const fanOut: RouteFanOut = async (state, questions) => {
    sent.push({ state: state as string, questions });
    return { answers, usage: { inputTokens: 1000, outputTokens: 0 }, cost: 0.000042 };
  };
  return { fanOut, sent };
}

const answers = (o: {
  intent?: string;
  ic?: number;
  tier?: string;
  tc?: number;
  risky?: number;
}) => ({
  intent: {
    type: 'choice',
    choice: o.intent ?? 'media',
    confidence: o.ic ?? 0.98,
    probabilities: {},
  },
  tier: { type: 'choice', choice: o.tier ?? 'cheap', confidence: o.tc ?? 0.9, probabilities: {} },
  risky: { type: 'noul', noul: o.risky ?? 0.1 },
});

const workflows = [
  { id: 'chat', description: 'Talk to the orchestrator', conversation: true },
  { id: 'fix-issue', description: 'Fix a GitHub issue end to end' },
  { id: 'land-feature', description: 'Build and land a feature' },
];

describe('routeRequest', () => {
  it('asks intent, tier and risky in one fan-out and maps the answers', async () => {
    const f = fake(answers({}));
    const r = await routeRequest(f.fanOut, {
      request: 'make me a picture of a cat',
      workflows,
      attachments: [{ path: 'attachments/cat.png', mime: 'image/png' }],
    });
    expect(f.sent).toHaveLength(1);
    expect(Object.keys(f.sent[0]?.questions ?? {})).toEqual(['intent', 'tier', 'risky']);
    expect(r).toEqual({
      intent: 'media',
      intentConfidence: 0.98,
      tier: 'cheap',
      tierConfidence: 0.9,
      risky: false,
      riskyProbability: 0.1,
      cost: { usd: 0.000042, inputTokens: 1000, outputTokens: 0 },
      model: 'jev-latest',
    });
    expect(f.sent[0]?.questions.risky?.type).toBe('noul');
    expect(f.sent[0]?.state).toContain('make me a picture of a cat');
    expect(f.sent[0]?.state).toContain('attachments/cat.png');
  });

  it('offers workflow:<id> for every non-conversation workflow, its description as the criterion', async () => {
    const f = fake(answers({ intent: 'workflow:fix-issue' }));
    const r = await routeRequest(f.fanOut, { request: 'fix issue 12', workflows });
    const q = f.sent[0]?.questions.intent as { type: string; criteria: Record<string, string> };
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual([
      'chat',
      'media',
      'code',
      'research',
      'workflow:fix-issue',
      'workflow:land-feature',
      'human',
    ]);
    expect(q.criteria['workflow:fix-issue']).toContain('Fix a GitHub issue end to end');
    const tier = f.sent[0]?.questions.tier as { criteria: Record<string, string> };
    expect(Object.keys(tier.criteria)).toEqual(['cheap', 'strong']);
    expect(r?.intent).toBe('workflow:fix-issue');
  });

  it('below 0.6 the intent is unsure; risky is a flag from 0.7', async () => {
    const low = await routeRequest(fake(answers({ ic: 0.55, risky: 0.7 })).fanOut, {
      request: 'hmm',
      workflows: [],
    });
    expect(low?.intent).toBe('unsure');
    expect(low?.intentConfidence).toBe(0.55);
    expect(low?.risky).toBe(true);
    const ok = await routeRequest(fake(answers({ ic: 0.6, risky: 0.69 })).fanOut, {
      request: 'hmm',
      workflows: [],
    });
    expect(ok?.intent).toBe('media');
    expect(ok?.risky).toBe(false);
  });

  it('bounds the state: 4 000 chars of request, a few names and short descriptions', async () => {
    const f = fake(answers({}));
    await routeRequest(f.fanOut, {
      request: 'x'.repeat(50_000),
      workflows: Array.from({ length: 200 }, (_, i) => ({
        id: `wf-${i}`,
        description: 'd'.repeat(5_000),
      })),
      attachments: Array.from({ length: 500 }, (_, i) => ({ path: `attachments/${i}.bin` })),
    });
    const state = f.sent[0]?.state ?? '';
    expect(state.length).toBeLessThanOrEqual(STATE_MAX_CHARS);
    expect(state).toContain('x'.repeat(REQUEST_MAX_CHARS - 1));
    expect(state).not.toContain('x'.repeat(REQUEST_MAX_CHARS + 1));
    const q = f.sent[0]?.questions.intent as { criteria: Record<string, string> };
    expect(JSON.stringify(q.criteria).length).toBeLessThan(20_000);
  });

  it('any error (a missing answer, a throw, a timeout) → undefined', async () => {
    expect(
      await routeRequest(fake({ tier: answers({}).tier }).fanOut, { request: 'x', workflows: [] }),
    ).toBeUndefined();
    const boom: RouteFanOut = async () => {
      throw new Error('500');
    };
    const errors: string[] = [];
    expect(
      await routeRequest(
        boom,
        { request: 'x', workflows: [] },
        { onError: (e) => errors.push(e.message) },
      ),
    ).toBeUndefined();
    expect(errors).toEqual(['500']);
    let aborted = false;
    const hang: RouteFanOut = (_s, _q, o) =>
      new Promise((_r, reject) => {
        o?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const t0 = Date.now();
    const timedOut: string[] = [];
    expect(
      await routeRequest(
        hang,
        { request: 'x', workflows: [] },
        { timeoutMs: 50, onError: (e) => timedOut.push(e.message) },
      ),
    ).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    expect(timedOut[0]).toMatch(/timed out after 50 ms/);
  });

  it('a signal already aborted aborts the fan-out at once', async () => {
    let aborted = false;
    const hang: RouteFanOut = (_s, _q, o) =>
      new Promise((_r, reject) => {
        if (o?.signal?.aborted) {
          aborted = true;
          reject(new Error('aborted'));
        }
        o?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    const ctrl = new AbortController();
    ctrl.abort();
    const t0 = Date.now();
    expect(
      await routeRequest(
        hang,
        { request: 'x', workflows: [] },
        { signal: ctrl.signal, timeoutMs: 5_000 },
      ),
    ).toBeUndefined();
    expect(aborted).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a workflow id longer than 120 chars is dropped from the options, never cut', async () => {
    const long = `w${'x'.repeat(120)}`;
    const f = fake(answers({ intent: 'chat' }));
    await routeRequest(f.fanOut, {
      request: 'hi',
      workflows: [{ id: long, description: 'too long' }, { id: 'short' }],
    });
    const q = f.sent[0]?.questions.intent as { criteria: Record<string, string> };
    expect(Object.keys(q.criteria)).toContain('workflow:short');
    expect(Object.keys(q.criteria).some((k) => k.startsWith('workflow:w'))).toBe(false);
    expect(f.sent[0]?.state).not.toContain('wxxx');
  });
});

describe('routeHint', () => {
  const base = {
    intentConfidence: 0.98,
    tier: 'cheap' as const,
    tierConfidence: 0.9,
    risky: false,
    riskyProbability: 0.1,
    cost: { usd: 0, inputTokens: 0, outputTokens: 0 },
    model: 'jev-latest' as const,
  };
  it('one line with intent, confidence, tier and risky, plus what to do for some intents', () => {
    expect(routeHint({ ...base, intent: 'chat' })).toBe(
      '[router] intent=chat (0.98) tier=cheap risky=no',
    );
    expect(routeHint({ ...base, intent: 'media', risky: true }, { hasMedia: true })).toBe(
      '[router] intent=media (0.98) tier=cheap risky=yes: generate it with Higgsfield now',
    );
    expect(routeHint({ ...base, intent: 'workflow:fix-issue' })).toContain(
      'start workflow fix-issue with start_workflow unless the user is only asking about it',
    );
    expect(routeHint({ ...base, intent: 'research' })).toContain('use your fetch/search tools');
    expect(routeHint({ ...base, intent: 'human' })).toContain('ask one precise question');
  });

  it('the media hint only when media generation is set up', () => {
    expect(routeHint({ ...base, intent: 'media' })).toBe(
      '[router] intent=media (0.98) tier=cheap risky=no',
    );
    expect(routeHint({ ...base, intent: 'media' }, { hasMedia: false })).not.toContain(
      'Higgsfield',
    );
  });
});
