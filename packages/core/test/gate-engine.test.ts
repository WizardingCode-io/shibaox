import { GateSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { defaultCheckRunners, type RunState, runGate } from '../src/index.js';

const state: RunState = {
  runId: 'r',
  workflow: 'w',
  input: {},
  workspace: process.cwd(),
  status: 'running',
  nodes: {},
  spentUsd: 0,
  budgetWarned: false,
};
const ctx = { runId: 'r', nodeId: 'g', workspace: process.cwd(), state, log: () => {} };
const gates = {
  ok: GateSchema.parse({
    gate: 'ok',
    checks: [{ name: 'echo', type: 'code', command: 'echo fine' }],
  }),
  bad: GateSchema.parse({
    gate: 'bad',
    checks: [
      { name: 'boom', type: 'code', command: 'echo broken >&2; exit 1' },
      { name: 'after', type: 'mock', passes: true },
    ],
  }),
  jev: GateSchema.parse({ gate: 'jev', checks: [{ name: 'spec', type: 'jev', question: 'q' }] }),
};

describe('runGate', () => {
  it('passes when every check passes', async () => {
    const r = await runGate({ gateIds: ['ok'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(true);
    expect(r.checks[0]).toMatchObject({ name: 'echo', passed: true });
    expect(r.checks[0]?.evidence).toContain('fine');
  });
  it('fails at the first failing check, skips the rest and keeps stderr as evidence', async () => {
    const r = await runGate({ gateIds: ['ok', 'bad'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(false);
    expect(r.checks.map((c) => [c.name, c.passed, c.skipped])).toEqual([
      ['echo', true, false],
      ['boom', false, false],
      ['after', false, true],
    ]);
    expect(r.checks[1]?.evidence).toContain('broken');
  });
  it('fails a check whose type has no runner', async () => {
    const r = await runGate({ gateIds: ['jev'], gates, runners: defaultCheckRunners(), ctx });
    expect(r.passed).toBe(false);
    expect(r.checks[0]?.evidence).toContain('no runner registered for check type "jev"');
  });
  it('throws on an unknown gate id', async () => {
    await expect(runGate({ gateIds: ['ghost'], gates, runners: {}, ctx })).rejects.toThrow('ghost');
  });
});
