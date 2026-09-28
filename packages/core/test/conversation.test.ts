import type { ChatMessage } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it, vi } from 'vitest';
import {
  compactConversation,
  condense,
  estimateTokens,
  splitConversation,
} from '../src/conversation.js';

const turn = (i: number, words = 40): ChatMessage[] => [
  { role: 'user', content: `question ${i} ${'lorem '.repeat(words)}` },
  { role: 'assistant', content: `answer ${i} ${'ipsum '.repeat(words)}` },
];

describe('compactConversation', () => {
  it('leaves a conversation under the cap alone and never calls the summariser', async () => {
    const summarize = vi.fn(async () => 'never');
    const messages = [...turn(1), ...turn(2)];
    expect(await compactConversation(messages, { maxTokens: 10_000, summarize })).toBe(messages);
    expect(summarize).not.toHaveBeenCalled();
  });
  it('folds the oldest turns into one summary message and keeps the newest ones whole', async () => {
    const summarize = vi.fn(async (text: string) => `SUMMARY(${text.length})`);
    const messages = Array.from({ length: 10 }, (_, i) => turn(i + 1)).flat();
    const total = estimateTokens(messages.map((m) => m.content).join('\n'));
    const out = await compactConversation(messages, {
      maxTokens: Math.floor(total / 2),
      summarize,
    });
    expect(out[0]).toMatchObject({ role: 'user', summary: true });
    expect(out[0]?.content).toMatch(/^SUMMARY\(\d+\)$/);
    // the kept tail is whole turns, the newest ones, and ends with the latest answer
    const tail = out.slice(1);
    expect(tail[0]?.role).toBe('user');
    expect(tail.at(-1)).toEqual(messages.at(-1));
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(messages.length);
    // the summariser saw the dropped turns, as a transcript, and not the kept ones
    const seen = summarize.mock.calls[0]?.[0] ?? '';
    expect(seen).toContain('question 1');
    expect(seen).not.toContain(String(tail[0]?.content));
  });
  it('an earlier summary is folded into the new one, so summaries never pile up', async () => {
    const summarize = vi.fn(async (text: string) => `S2 from [${text.slice(0, 20)}]`);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'S1: they discussed the schema', summary: true },
      ...Array.from({ length: 8 }, (_, i) => turn(i + 1)).flat(),
    ];
    const out = await compactConversation(messages, { maxTokens: 200, summarize });
    expect(out.filter((m) => m.summary)).toHaveLength(1);
    expect(summarize.mock.calls[0]?.[0]).toContain('S1: they discussed the schema');
    expect(out[0]?.content.startsWith('S2 from [')).toBe(true);
  });
  it('a failing summariser falls back to a plain condensation instead of losing the turns', async () => {
    const summarize = vi.fn(async () => {
      throw new Error('no model');
    });
    const messages = Array.from({ length: 8 }, (_, i) => turn(i + 1)).flat();
    const out = await compactConversation(messages, { maxTokens: 200, summarize });
    expect(out[0]?.summary).toBe(true);
    expect(out[0]?.content).toMatch(/Assistant: answer \d+/); // the newest dropped turn
    expect(out[0]?.content).toContain('earlier message(s) omitted');
    expect(estimateTokens(out[0]?.content ?? '')).toBeLessThanOrEqual(100);
  });
});

describe('compactConversation without a model (condense)', () => {
  it('keeps the newest dropped turns and a capped share of the earlier summary; the label counts what was omitted', () => {
    const turns = Array.from({ length: 30 }, (_, i) => turn(i + 1, 20)).flat();
    const out = condense('S'.repeat(4000), turns, 300);
    expect(out).toContain('question 30'); // the newest dropped turn is there
    expect(out).not.toContain('question 1 '); // the oldest are what goes
    expect(out).toMatch(/\d+ earlier message\(s\) omitted/);
    expect(out.startsWith('S')).toBe(true);
    expect(out.indexOf('SSSS')).toBeLessThan(out.indexOf('question')); // summary first, but capped
    expect(estimateTokens(out)).toBeLessThanOrEqual(320);
  });
  it('an oversized summary from the model is replaced by the condensation', async () => {
    const messages = Array.from({ length: 8 }, (_, i) => turn(i + 1)).flat();
    const out = await compactConversation(messages, {
      maxTokens: 200,
      summarize: async () => 'x '.repeat(2000),
    });
    expect(estimateTokens(out[0]?.content ?? '')).toBeLessThanOrEqual(100);
    expect(out[0]?.content).toMatch(/Assistant: answer \d+/);
  });
  it('the last user turn and its reply are always kept whole, even when larger than the cap', async () => {
    const messages: ChatMessage[] = [
      ...turn(1),
      { role: 'user', content: 'fix line 3 of what you just wrote' },
      { role: 'assistant', content: 'code '.repeat(5000) },
    ];
    const out = await compactConversation(messages, { maxTokens: 500, summarize: async () => 'S' });
    expect(out.slice(-2)).toEqual(messages.slice(-2));
    expect(out[0]?.summary).toBe(true);
  });
});

describe('splitConversation', () => {
  it('separates the summary from the turns for the adapters', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'earlier: x', summary: true },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(splitConversation(messages)).toEqual({
      summary: 'earlier: x',
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    expect(splitConversation([])).toEqual({ summary: undefined, turns: [] });
  });
});
