import { createHash } from 'node:crypto';
import { AlreadyResolvedError, type InboxAnswer, type InboxId, type InboxItem } from '../inbox.js';
import { chunkText, type RunReport, STATUS_SYMBOL, shortDuration } from '../runs/report.js';
import type { Channel } from './types.js';

export interface TelegramOptions {
  token: string;
  chatId: number;
  /** Resolves a callback token to the inbox item it stands for (after a restart). */
  lookup?: (token: string) => Promise<InboxId | undefined>;
  /** `https://api.telegram.org/bot` by default; tests point it at a fake. */
  apiBase?: string;
  fetch?: typeof fetch;
  log: (line: string) => void;
  /** Long-polling wait (default 30 s; 0 for tests). */
  pollTimeoutSeconds?: number;
}

/** `callback_data` is limited to 64 bytes: a short, deterministic token stands for the item. */
export const inboxToken = (id: string): string =>
  createHash('sha256').update(id).digest('hex').slice(0, 16);

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

/** Telegram messages take at most 4096 chars; text is sent in pieces under this. */
export const TELEGRAM_CHUNK = 4000;

/** The report as a Telegram message: a conversation's reply as is, a run as a short digest. */
export function telegramReportText(r: RunReport): string {
  if (r.reply !== undefined && r.nodes.every((n) => n.status === 'completed'))
    return escapeHtml(r.reply);
  const symbol = STATUS_SYMBOL[r.status] ?? '•';
  const word = r.status === 'completed' ? 'done' : r.status.replace('_', ' ');
  const head = [
    `${symbol} ${escapeHtml(r.workflow)} ${word}`,
    `${r.nodes.length} node${r.nodes.length === 1 ? '' : 's'}`,
    `$${r.spentUsd.toFixed(4)}`,
    ...(r.durationMs !== undefined ? [shortDuration(r.durationMs)] : []),
    ...(r.branch ? [`branch ${escapeHtml(r.branch)}`] : []),
  ].join(' · ');
  const lines = [head];
  if (r.needs) lines.push(`needs you: ${escapeHtml(r.needs)}`);
  if (r.error) lines.push(`error: ${escapeHtml(r.error)}`);
  for (const n of r.nodes)
    if (n.summary) lines.push(`${escapeHtml(n.id)}: ${escapeHtml(n.summary)}`);
  if (r.notePath) lines.push(`note: ${escapeHtml(r.notePath)}`);
  return lines.join('\n');
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
  const tokens = new Map<string, InboxId>();
  const resolveToken = async (t: string): Promise<InboxId | undefined> =>
    tokens.get(t) ?? (await o.lookup?.(t));
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
    const m = /^(approve|deny):([0-9a-f]{16})$/.exec(cb.data ?? '');
    const id = m ? await resolveToken(m[2] as string) : undefined;
    if (!m || !answer || !id) {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Unknown action' });
      return;
    }
    const approved = m[1] === 'approve';
    try {
      await answer(id, { approved });
      await api('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: approved ? 'Approved' : 'Denied',
      });
    } catch (e) {
      const text =
        e instanceof AlreadyResolvedError ? 'Already answered' : 'Could not record the answer';
      o.log(`[telegram] answer for ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
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
      const token = inboxToken(item.id);
      tokens.set(token, item.id);
      const r = await api<{ message_id: number }>('sendMessage', {
        chat_id: o.chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Approve', callback_data: `approve:${token}` },
              { text: 'Deny', callback_data: `deny:${token}` },
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
    async report(r) {
      for (const piece of chunkText(telegramReportText(r), TELEGRAM_CHUNK))
        await api('sendMessage', { chat_id: o.chatId, text: piece, parse_mode: 'HTML' });
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
