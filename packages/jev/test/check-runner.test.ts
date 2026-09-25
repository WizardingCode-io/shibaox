import { afterEach, describe, expect, it } from 'vitest';
import { JevClient, jevCheckRunner, truncateState } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => {
  await fake?.close();
});
const ctx = {
  runId: 'r',
  nodeId: 'qa',
  workspace: process.cwd(),
  state: {
    runId: 'r',
    workflow: 'w',
    input: { spec: 'add /health' },
    workspace: '',
    status: 'running',
    nodes: { implement: { status: 'completed', attempts: 1, output: { summary: 'added route' } } },
    spentUsd: 0,
    budgetWarned: false,
    pendingHumans: [],
  },
  log: () => {},
} as const;

describe('jevCheckRunner', () => {
  it('passes a noul check above threshold with confidence and cost', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.92 } }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run(
      {
        name: 'spec',
        type: 'jev',
        question: 'The output implements the spec',
        kind: 'noul',
        threshold: 0.8,
      },
      ctx as never,
    );
    expect(r).toMatchObject({ name: 'spec', type: 'jev', passed: true, confidence: 0.92 });
    expect(r.cost?.usd).toBeGreaterThan(0);
    expect(r.evidence).toContain('0.92');
  });
  it('fails below the fail line and escalates in the grey zone when an escalation runner exists', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.65 } }));
    const escalate = async () => ({
      name: 'spec',
      type: 'judge' as const,
      passed: true,
      skipped: false,
      evidence: 'judge says ok',
    });
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), { escalate });
    const r = await run(
      { name: 'spec', type: 'jev', question: 'q', kind: 'noul', threshold: 0.8 },
      ctx as never,
    );
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('escalated');
  });
  it('never passes on low confidence without escalation', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.65 } }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run(
      { name: 'spec', type: 'jev', question: 'q', kind: 'noul', threshold: 0.8 },
      ctx as never,
    );
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain('judge');
  });
  it('score checks pass when the normalised score meets the threshold', async () => {
    fake = await startFakeJev(() => ({
      check: {
        type: 'score',
        score: 2,
        confidence: 0.9,
        legend: ['bad', 'ok', 'good'],
        probabilities: [0, 0.1, 0.9],
      },
    }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run(
      { name: 'q', type: 'jev', question: 'Quality', kind: 'score', threshold: 0.8 },
      ctx as never,
    );
    expect(r.passed).toBe(true);
  });
});

describe('truncateState', () => {
  it('keeps spec first, then output, then diff, within the limit', () => {
    const s = truncateState(
      { spec: 'S'.repeat(50), output: 'O'.repeat(50), diff: 'D'.repeat(50) },
      120,
    );
    expect(s.startsWith('## spec')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s).toContain('SSSS');
    expect(s).not.toContain('DDDD');
  });
});
