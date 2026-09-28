import { describe, expect, it } from 'vitest';
import { CheckResultSchema, GateSchema } from '../src/index.js';

describe('GateSchema', () => {
  it('parses a gate with code, jev, judge, human and mock checks', () => {
    const g = GateSchema.parse({
      gate: 'qa',
      checks: [
        { name: 'tests', type: 'code', command: 'npm test' },
        { name: 'spec', type: 'jev', question: 'The diff implements the spec' },
        { name: 'review', type: 'judge', role: 'team-leader', rubric: 'Correct and minimal' },
        { name: 'ok', type: 'human', prompt: 'Looks good?' },
        { name: 'always', type: 'mock', passes: true },
      ],
    });
    expect(g.checks[0]).toMatchObject({ type: 'code', timeout_ms: 300_000 });
    expect(g.checks[1]).toMatchObject({ type: 'jev', kind: 'noul', threshold: 0.8 });
  });

  it('rejects an empty checks list', () => {
    expect(GateSchema.safeParse({ gate: 'x', checks: [] }).success).toBe(false);
  });
});

describe('the tests check', () => {
  it('needs no command: the runner is detected in the workspace', () => {
    const g = GateSchema.parse({ gate: 'tests', checks: [{ name: 'unit-tests', type: 'tests' }] });
    expect(g.checks[0]).toMatchObject({ type: 'tests', timeout_ms: 300_000 });
  });
});

describe('lint and review checks', () => {
  it('parse with their defaults', () => {
    const g = GateSchema.parse({
      gate: 'quality',
      checks: [
        { name: 'lint', type: 'lint' },
        { name: 'style', type: 'lint', command: 'pnpm biome check .' },
        { name: 'review', type: 'review' },
        { name: 'strict', type: 'review', criteria: ['No TODOs left', 'Tests cover the change'] },
      ],
    });
    expect(g.checks[0]).toMatchObject({ type: 'lint', timeout_ms: 300_000 });
    expect(g.checks[2]).toMatchObject({ type: 'review' });
    expect(g.checks[3]).toMatchObject({ criteria: ['No TODOs left', 'Tests cover the change'] });
    expect(
      CheckResultSchema.parse({ name: 'x', type: 'review', passed: true, evidence: 'ok' }).type,
    ).toBe('review');
    expect(
      CheckResultSchema.parse({ name: 'x', type: 'lint', passed: true, evidence: 'ok' }).type,
    ).toBe('lint');
  });
});
