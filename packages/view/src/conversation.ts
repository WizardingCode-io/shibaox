/**
 * The conversation carried in a run's input (`input.messages`), without zod: the same shape
 * as `ChatMessageSchema` in schemas (role user | assistant, content, an optional `summary`
 * flag on a condensed turn). Kept here so the browser never loads the schema package.
 */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  summary?: boolean;
}

export function conversationOf(input: Record<string, unknown> | undefined): ChatMessage[] {
  const raw = input?.messages;
  if (!Array.isArray(raw)) return [];
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const { role, content, summary } = m as Record<string, unknown>;
    if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string') continue;
    out.push({ role, content, ...(summary === true ? { summary: true } : {}) });
  }
  return out;
}

/** A turn submitted by shibaox itself (a dispatched run ended), never by the user. */
export function isEventTurn(input: Record<string, unknown> | undefined): boolean {
  return input?.event === true;
}
