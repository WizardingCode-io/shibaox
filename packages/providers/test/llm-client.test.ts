import { tool } from 'ai';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, type ProviderEntry, ProviderRegistry } from '../src/index.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
const entryFor = (baseURL: string): ProviderEntry => ({
  id: 'fake',
  name: 'Fake',
  kind: 'openai-compatible',
  base_url: baseURL,
  auth: { type: 'none' },
  models: [],
  pricing: { m: { input_per_m: 1, output_per_m: 2 } },
  verify: false,
  capabilities: { tools: true },
});

describe('LlmClient over an OpenAI-compatible fake', () => {
  afterAll(async () => {
    await fake?.close();
  });

  it('returns text and usage, and estimates cost', async () => {
    fake = await startFakeOpenAI(() => ({ content: 'hello there' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('hello there');
    expect(r.finishReason).toBe('stop');
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.cost).toBeCloseTo((r.usage.inputTokens * 1 + r.usage.outputTokens * 2) / 1_000_000);
    await fake.close();
  });

  it('runs a tool call round-trip and stops at maxSteps', async () => {
    fake = await startFakeOpenAI((_req, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'add', args: { a: 2, b: 3 } }] }
        : { content: 'the sum is 5' },
    );
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', {
      messages: [{ role: 'user', content: 'add 2 and 3' }],
      tools: {
        add: tool({
          description: 'add',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => a + b,
        }),
      },
      maxSteps: 3,
    });
    expect(r.text).toBe('the sum is 5');
    expect(r.steps).toBe(2);
    // the last step's prompt is what sits in the context; the total adds every step up
    expect(r.lastStepInputTokens).toBeGreaterThan(0);
    expect(r.lastStepInputTokens).toBeLessThan(r.usage.inputTokens);
    expect(fake.requests).toHaveLength(2);
    await fake.close();
  });

  it('stops the loop as soon as a stopOnTools tool is called', async () => {
    fake = await startFakeOpenAI(() => ({ toolCalls: [{ name: 'done', args: {} }] }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    let calls = 0;
    const r = await client.generate('fake/m', {
      messages: [{ role: 'user', content: 'go' }],
      tools: {
        done: tool({
          inputSchema: z.object({}),
          execute: async () => {
            calls++;
            return { ok: true };
          },
        }),
      },
      maxSteps: 5,
      stopOnTools: ['done'],
    });
    expect(calls).toBe(1);
    expect(r.steps).toBe(1);
    expect(r.finishReason).toBe('tool-calls');
    expect(fake.requests).toHaveLength(1);
    await fake.close();
  });

  it('returns a validated object with output', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"passed": true, "evidence": "ok"}' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', {
      messages: [{ role: 'user', content: 'judge' }],
      output: z.object({ passed: z.boolean(), evidence: z.string() }),
    });
    expect(r.output).toEqual({ passed: true, evidence: 'ok' });
    await fake.close();
  });

  it('surfaces a throwing script as a rejected generate() call instead of hanging or crashing', async () => {
    fake = await startFakeOpenAI(() => {
      throw new Error('upstream down');
    });
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    await expect(
      client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }], maxRetries: 0 }),
    ).rejects.toThrow(/upstream down/);
    expect(fake.requests).toHaveLength(1); // maxRetries is forwarded to the SDK
    await fake.close();
  });

  it('supports a script that resolves its turn asynchronously', async () => {
    fake = await startFakeOpenAI(
      () => new Promise((resolve) => setTimeout(() => resolve({ content: 'delayed' }), 20)),
    );
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('delayed');
    await fake.close();
  });

  it('close() resolves promptly right after a completed request', async () => {
    fake = await startFakeOpenAI(() => ({ content: 'done' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    await client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }] });
    const start = Date.now();
    await fake.close();
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('generateObject', () => {
  it('falls back to the JSON in a plain-text answer when the model cannot do structured output', async () => {
    let calls = 0;
    fake = await startFakeOpenAI(() => {
      calls++;
      // the first answer is prose around JSON: JSON mode "did not match schema"; the retry gets the object
      return calls === 1
        ? { content: 'Sure thing! Here you go: {"choice":"ship","reasoning":"tests pass"} — done.' }
        : { content: '{"choice":"ship","reasoning":"tests pass"}' };
    });
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generateObject(
      'fake/m',
      { messages: [{ role: 'user', content: 'ship?' }] },
      z.object({ choice: z.enum(['ship', 'rework']), reasoning: z.string() }),
    );
    expect(r.output).toEqual({ choice: 'ship', reasoning: 'tests pass' });
    expect(calls).toBeLessThanOrEqual(2);
    // the retry says which shape is expected (the schema only travelled in JSON mode before)
    const last = (fake.requests.at(-1) as { messages: { content: string }[] }).messages.at(-1);
    expect(String(last?.content)).toContain('"choice"');
    expect(String(last?.content)).toContain('"reasoning"');
    await fake.close();
  });
});

describe('generateStream', () => {
  it('delivers the text as it arrives and ends with the same result as generate', async () => {
    fake = await startFakeOpenAI((_req, turn) =>
      turn === 0
        ? { toolCalls: [{ name: 'add', args: { a: 2, b: 3 } }] }
        : { content: 'The sum is 5, streamed piece by piece.' },
    );
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const deltas: string[] = [];
    const r = await client.generateStream('fake/m', {
      messages: [{ role: 'user', content: 'add 2 and 3' }],
      tools: {
        add: tool({
          description: 'add',
          inputSchema: z.object({ a: z.number(), b: z.number() }),
          execute: async ({ a, b }) => a + b,
        }),
      },
      maxSteps: 3,
      onText: (d) => deltas.push(d),
    });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('The sum is 5, streamed piece by piece.');
    expect(r.text).toBe('The sum is 5, streamed piece by piece.');
    expect(r.steps).toBe(2);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect((fake.requests[0] as { stream?: boolean }).stream).toBe(true);
    await fake.close();
  });
});
