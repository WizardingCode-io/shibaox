import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_CRITERIA,
  judgeCheckRunner,
  LeadDecider,
  LlmClient,
  ProviderRegistry,
  reviewCheckRunner,
} from '../src/index.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
afterEach(async () => {
  await fake?.close();
});
const reg = (baseURL: string) =>
  new ProviderRegistry(
    [
      {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible',
        base_url: baseURL,
        auth: { type: 'none' },
        models: [],
        pricing: {},
        verify: false,
        capabilities: { tools: true },
      },
    ],
    {},
  );
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
    nodes: {},
    spentUsd: 0,
    budgetWarned: false,
    pendingHumans: [],
  },
  log: () => {},
} as const;

describe('judgeCheckRunner', () => {
  it('turns the structured verdict into a CheckResult', async () => {
    fake = await startFakeOpenAI(() => ({
      content: '{"passed": false, "evidence": "no tests", "suggestion": "add a test"}',
    }));
    const run = judgeCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run(
      { name: 'review', type: 'judge', role: 'team-leader', rubric: 'Tests must exist' },
      ctx as never,
    );
    expect(r).toMatchObject({
      type: 'judge',
      passed: false,
      evidence: 'no tests',
      suggestion: 'add a test',
    });
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    expect(sent.messages.map((m) => m.content).join('\n')).toContain('Tests must exist');
  });

  it('includes the workspace diff in the judge message when ctx.diff is configured', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"passed": true, "evidence": "ok"}' }));
    const run = judgeCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const withDiff = { ...ctx, diff: async () => 'diff --git a/x b/x' };
    await run(
      { name: 'review', type: 'judge', role: 'team-leader', rubric: 'x' },
      withDiff as never,
    );
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    const content = sent.messages.map((m) => m.content).join('\n');
    expect(content).toContain('## diff');
    expect(content).toContain('diff --git');
  });
});

describe('judgeCheckRunner errors and signal', () => {
  it('turns a provider error into a failed check with the message and status', async () => {
    fake = await startFakeOpenAI(() => {
      throw new Error('boom');
    });
    const run = judgeCheckRunner(new LlmClient(reg(fake.baseURL), { maxRetries: 0 }), 'fake/m');
    const ac = new AbortController();
    const r = await run({ name: 'review', type: 'judge', role: 'team-leader', rubric: 'x' }, {
      ...ctx,
      signal: ac.signal,
    } as never);
    expect(r).toMatchObject({ name: 'review', type: 'judge', passed: false, skipped: false });
    expect(r.evidence).toContain('boom');
    expect(r.evidence).toContain('HTTP 500');
  });
  it('forwards the run signal: an aborted run makes no model call', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"passed": true, "evidence": "ok"}' }));
    const run = judgeCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const ac = new AbortController();
    ac.abort(new Error('run cancelled'));
    const r = await run({ name: 'review', type: 'judge', role: 'team-leader', rubric: 'x' }, {
      ...ctx,
      signal: ac.signal,
    } as never);
    expect(r.passed).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('LeadDecider', () => {
  it('chooses among the node options', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"choice": "rework", "reasoning": "flaky"}' }));
    const d = new LeadDecider(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await d.decide({
      runId: 'r',
      nodeId: 'judge',
      by: 'team-leader',
      question: 'Ready?',
      options: ['ship', 'rework'],
      context: { input: {}, previousOutputs: {} },
    });
    expect(r.choice).toBe('rework');
    expect(r.by).toBe('model:fake/m');
  });

  it('fails instead of guessing when the model returns no structured decision', async () => {
    fake = await startFakeOpenAI(() => ({ content: 'not json at all' }));
    const d = new LeadDecider(new LlmClient(reg(fake.baseURL)), 'fake/m');
    await expect(
      d.decide({
        runId: 'r',
        nodeId: 'judge',
        by: 'team-leader',
        question: 'Ready?',
        options: ['ship', 'rework'],
        context: { input: {}, previousOutputs: {} },
      }),
    ).rejects.toThrow();
  });
  it('reports provider errors with the message and status, and forwards the signal', async () => {
    fake = await startFakeOpenAI(() => {
      throw new Error('boom');
    });
    const d = new LeadDecider(new LlmClient(reg(fake.baseURL), { maxRetries: 0 }), 'fake/m');
    const req = {
      runId: 'r',
      nodeId: 'judge',
      by: 'team-leader',
      question: 'Ready?',
      options: ['ship', 'rework'],
      context: { input: {}, previousOutputs: {} },
    };
    await expect(d.decide(req)).rejects.toThrow(/lead decider fake\/m failed: .*boom.*HTTP 500/);
    const before = fake.requests.length;
    const ac = new AbortController();
    ac.abort(new Error('run cancelled'));
    await expect(d.decide({ ...req, signal: ac.signal })).rejects.toThrow(/lead decider/);
    expect(fake.requests).toHaveLength(before);
  });
});

describe('reviewCheckRunner', () => {
  it('judges each criterion; one failing criterion fails the check with its reasons and suggestions', async () => {
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({
        findings: [
          { criterion: 'Scope', passed: true, evidence: 'only /health touched' },
          {
            criterion: 'Tests',
            passed: false,
            evidence: 'no test for /health',
            suggestion: 'add math.test.js case',
          },
        ],
      }),
    }));
    const run = reviewCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run({ name: 'review', type: 'review', criteria: ['Scope', 'Tests'] }, {
      ...ctx,
      diff: async () => '+app.get("/health")',
    } as never);
    expect(r).toMatchObject({ type: 'review', passed: false, skipped: false });
    expect(r.evidence).toContain('✓ Scope');
    expect(r.evidence).toContain('✗ Tests: no test for /health');
    expect(r.suggestion).toContain('add math.test.js case');
    expect(r.cost).toBeDefined();
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    const text = sent.messages.map((m) => m.content).join('\n');
    expect(text).toContain('1. Scope');
    expect(text).toContain('2. Tests');
    expect(text).toContain('+app.get("/health")');
  });
  it('without criteria the built-in code review rubric applies; all passing passes', async () => {
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({
        findings: DEFAULT_REVIEW_CRITERIA.map((c) => ({
          criterion: c,
          passed: true,
          evidence: 'ok',
        })),
      }),
    }));
    const run = reviewCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run({ name: 'review', type: 'review' }, ctx as never);
    expect(r.passed).toBe(true);
    expect(DEFAULT_REVIEW_CRITERIA.length).toBeGreaterThanOrEqual(4);
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    expect(sent.messages.map((m) => m.content).join('\n')).toContain(
      DEFAULT_REVIEW_CRITERIA[0] ?? '',
    );
  });
  it('findings are matched by number, then text, each used once: a failing one is never lost', async () => {
    // out of order, one abbreviated, one duplicated, one extra: the numbers decide
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({
        findings: [
          {
            n: 2,
            criterion: 'Docs',
            passed: false,
            evidence: 'greet() has no doc comment',
            suggestion: 'document greet()',
          },
          { n: 1, criterion: 'No TODOs', passed: true, evidence: 'none' },
          { n: 1, criterion: 'No TODOs', passed: false, evidence: 'duplicate row' },
          { criterion: 'Overall', passed: true, evidence: 'fine' },
        ],
      }),
    }));
    const run = reviewCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run(
      { name: 'review', type: 'review', criteria: ['No TODOs', 'Docs on public fns'] },
      ctx as never,
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('✓ No TODOs: none');
    expect(r.evidence).toContain('✗ Docs on public fns: greet() has no doc comment');
    expect(r.suggestion).toContain('document greet()');
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    expect(sent.messages.map((m) => m.content).join('\n')).toMatch(/"n"/); // the prompt asks for the number
  });
  it('without numbers, a shared prefix never steals another criterion\'s finding; "true" strings are read as booleans', async () => {
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({
        findings: [
          { criterion: 'Tests coverage: 80%', passed: 'false', evidence: 'coverage 40%' },
          { criterion: 'Tests: unit pass', passed: 'true', evidence: 'all green' },
        ],
      }),
    }));
    const run = reviewCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run(
      { name: 'review', type: 'review', criteria: ['Tests: unit pass', 'Tests coverage: 80%'] },
      ctx as never,
    );
    expect(r.evidence).toContain('✓ Tests: unit pass: all green');
    expect(r.evidence).toContain('✗ Tests coverage: 80%: coverage 40%');
    expect(r.passed).toBe(false);
  });
  it('a criterion the model left out counts as not reviewed: the check fails and says so', async () => {
    fake = await startFakeOpenAI(() => ({
      content: JSON.stringify({ findings: [{ criterion: 'Scope', passed: true, evidence: 'ok' }] }),
    }));
    const run = reviewCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run(
      { name: 'review', type: 'review', criteria: ['Scope', 'Tests'] },
      ctx as never,
    );
    expect(r.passed).toBe(false);
    expect(r.evidence).toContain('✗ Tests: not reviewed');
  });
});
