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
});
