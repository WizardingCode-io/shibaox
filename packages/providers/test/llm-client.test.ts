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
      client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/upstream down/);
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
