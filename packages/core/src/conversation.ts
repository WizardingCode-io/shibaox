import type { ChatMessage } from '@shibaox/schemas';

/** Tokens a text takes, roughly: four characters each (no tokenizer in the loop). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const messageTokens = (m: ChatMessage): number => estimateTokens(m.content) + 4;

/** The summary (if any) apart from the turns: the adapters put the first in the system prompt. */
export function splitConversation(messages: readonly ChatMessage[]): {
  summary: string | undefined;
  turns: ChatMessage[];
} {
  const summary = messages.find((m) => m.summary)?.content;
  return {
    summary,
    turns: messages.filter((m) => !m.summary).map(({ role, content }) => ({ role, content })),
  };
}

/** The dropped turns as a transcript for the summariser (an earlier summary first). */
const transcript = (summary: string | undefined, turns: readonly ChatMessage[]): string =>
  [
    ...(summary ? [`Summary so far:\n${summary}`] : []),
    ...turns.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`),
  ].join('\n\n');

/**
 * Without a model: the earlier summary (cut to half the budget) and each dropped turn cut to
 * a line, the newest ones kept when not all fit. What is omitted is counted, never silent.
 */
export function condense(
  summary: string | undefined,
  turns: readonly ChatMessage[],
  maxTokens: number,
): string {
  const head = summary ? summary.slice(0, Math.floor(maxTokens / 2) * 4) : undefined;
  let budget = maxTokens - (head ? estimateTokens(head) + 1 : 0);
  const lines = turns.map(
    (m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 160)}`,
  );
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    const t = estimateTokens(l) + 1;
    if (t > budget) break;
    kept.unshift(l);
    budget -= t;
  }
  const omitted = lines.length - kept.length;
  return [
    ...(head ? [head] : []),
    ...(omitted > 0 ? [`… ${omitted} earlier turn(s) omitted.`] : []),
    ...kept,
  ].join('\n');
}

export interface CompactOptions {
  /** The whole conversation may take this many tokens (estimated). */
  maxTokens: number;
  /** How much of it the newest turns keep whole (default: half of `maxTokens`). */
  keepTokens?: number;
  /** Condenses a transcript to a short summary (a cheap model); a failure falls back to `condense`. */
  summarize: (transcript: string) => Promise<string>;
}

/**
 * A conversation that no longer fits: the oldest turns (and any earlier summary) become one
 * summary message, marked `summary: true`, ahead of the newest whole turns. The same array
 * comes back when nothing needs to change, so callers can compare by identity.
 */
export async function compactConversation(
  messages: ChatMessage[],
  o: CompactOptions,
): Promise<ChatMessage[]> {
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
  if (total <= o.maxTokens) return messages;
  const keepTokens = o.keepTokens ?? Math.floor(o.maxTokens / 2);
  const { summary, turns } = splitConversation(messages);
  // keep whole exchanges from the end: the tail always starts with a user turn
  let kept = 0;
  let cut = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = messageTokens(turns[i] as ChatMessage);
    if (kept + t > keepTokens) break;
    kept += t;
    cut = i;
  }
  while (cut < turns.length && turns[cut]?.role !== 'user') cut++;
  // the latest exchange stays whole whatever its size: "fix line 3 of what you just wrote"
  if (cut >= turns.length) {
    for (let i = turns.length - 1; i >= 0; i--)
      if (turns[i]?.role === 'user') {
        cut = i;
        break;
      }
  }
  const dropped = turns.slice(0, cut);
  const tail = turns.slice(cut);
  const summaryBudget = Math.max(64, Math.floor((o.maxTokens - keepTokens) / 2));
  let text: string;
  try {
    text = (await o.summarize(transcript(summary, dropped))).trim();
    if (!text) throw new Error('empty summary');
    if (estimateTokens(text) > summaryBudget) throw new Error('summary too long');
  } catch {
    text = condense(summary, dropped, summaryBudget);
  }
  return [{ role: 'user', content: text, summary: true }, ...tail];
}

/** What the summariser is asked, whichever model does it. */
export const SUMMARY_PROMPT =
  'Condense this conversation transcript into a short summary (under 200 words) that keeps every decision, fact, name, path and open question a colleague would need to continue it. Plain text, no preamble.';
