import { afterEach, describe, expect, it } from 'vitest';
import { judgeCheckRunner, LeadDecider, LlmClient, ProviderRegistry } from '../src/index.js';
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
