import { AlreadyResolvedError, type InboxAnswer, type InboxId, type InboxItem } from '../inbox.js';
import type { Channel } from './types.js';

export interface TelegramOptions {
  token: string;
  chatId: number;
  /** `https://api.telegram.org/bot` by default; tests point it at a fake. */
  apiBase?: string;
  fetch?: typeof fetch;
  log: (line: string) => void;
  /** Long-polling wait (default 30 s; 0 for tests). */
  pollTimeoutSeconds?: number;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The message text for an item: what is asked, where, and nothing from the workspace. */
export function telegramText(item: InboxItem): string {
  const where = [`Run ${item.runId.slice(0, 8)}`, `node ${item.nodeId}`];
  if (item.detail.role) where.push(`role ${item.detail.role}`);
  if (item.kind === 'approval')
    return `Approval needed\n${where.join(' · ')}\n<code>${escapeHtml(item.prompt)}</code>`;
  return `Decision needed\n${where.join(' · ')}\n${escapeHtml(item.prompt)}`;
}

interface CallbackQuery {
  id: string;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
}

/** Telegram Bot API over `fetch`: inline Approve/Deny buttons, long polling for the answers. */
export function telegramChannel(o: TelegramOptions): Channel {
  const base = `${o.apiBase ?? 'https://api.telegram.org/bot'}${o.token}`;
  const doFetch = o.fetch ?? fetch;
  const messages = new Map<string, { messageId: number; text: string }>();
  let answer: ((id: InboxId, a: { approved: boolean; note?: string }) => Promise<void>) | undefined;
  let polling: AbortController | undefined;
  let offset = 0;

  async function api<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await doFetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok)
      throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
    return json.result as T;
  }

  async function handle(u: Update): Promise<void> {
    const cb = u.callback_query;
    if (!cb) return;
    const chat = cb.message?.chat.id;
    if (chat !== o.chatId) {
      o.log(`[telegram] ignored callback from chat ${chat}`);
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not allowed' });
      return;
    }
    const m = /^(approve|deny):(.+)$/.exec(cb.data ?? '');
    if (!m || !answer) {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unknown action' });
      return;
    }
    const approved = m[1] === 'approve';
    try {
      await answer(m[2] as InboxId, { approved });
      await api('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: approved ? 'Approved' : 'Denied',
      });
    } catch (e) {
      const text =
        e instanceof AlreadyResolvedError ? 'Already answered' : 'Could not record the answer';
      o.log(`[telegram] answer for ${m[2]} failed: ${e instanceof Error ? e.message : String(e)}`);
      await api('answerCallbackQuery', { callback_query_id: cb.id, text });
    }
  }

  async function poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await api<Update[]>(
          'getUpdates',
          { offset, timeout: o.pollTimeoutSeconds ?? 30, allowed_updates: ['callback_query'] },
          signal,
        );
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          await handle(u).catch((e: unknown) =>
            o.log(`[telegram] ${e instanceof Error ? e.message : String(e)}`),
          );
        }
        if (updates.length === 0 && (o.pollTimeoutSeconds ?? 30) === 0)
          await new Promise((r) => setTimeout(r, 20));
      } catch (e) {
        if (signal.aborted) return;
        o.log(`[telegram] polling failed: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  return {
    id: 'telegram',
    async notify(item) {
      const text = telegramText(item);
      const r = await api<{ message_id: number }>('sendMessage', {
        chat_id: o.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `approve:${item.id}` },
              { text: 'Deny', callback_data: `deny:${item.id}` },
            ],
          ],
        },
      });
      messages.set(item.id, { messageId: r.message_id, text });
    },
    async resolved(item: InboxItem, a: InboxAnswer) {
      const m = messages.get(item.id);
      if (!m) return;
      messages.delete(item.id);
      await api('editMessageText', {
        chat_id: o.chatId,
        message_id: m.messageId,
        text: `${m.text}\n\n${a.approved ? 'Approved' : 'Denied'} via ${a.via}`,
        parse_mode: 'HTML',
      });
    },
    onAnswer(cb) {
      answer = cb;
    },
    async start() {
      polling = new AbortController();
      void poll(polling.signal);
    },
    async stop() {
      polling?.abort();
      polling = undefined;
    },
  };
}
