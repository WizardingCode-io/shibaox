import { createHash } from 'node:crypto';
import { AlreadyResolvedError, type InboxAnswer, type InboxId, type InboxItem } from '../inbox.js';
import {
  chunkBy,
  chunkText,
  type RunReport,
  STATUS_SYMBOL,
  shortDuration,
} from '../runs/report.js';
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
  /** What `/status` answers (the daemon's health as text). */
  status?: () => Promise<string>;
  /** The first `getUpdates` offset (past what a pairing already read: never replayed). */
  offset?: number;
}

const HELP = [
  'Type anything to talk to the orchestrator; it answers here.',
  '/status — the daemon, its runs and what needs you',
  '/help — this',
].join('\n');

/** `callback_data` is limited to 64 bytes: a short, deterministic token stands for the item. */
export const inboxToken = (id: string): string =>
  createHash('sha256').update(id).digest('hex').slice(0, 16);

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The message text for an item: what is asked, where, and nothing from the workspace. */
export function telegramText(item: InboxItem): string {
  const where = [`Run ${item.runId.slice(0, 8)}`, `node ${item.nodeId}`];
  if (item.detail.role) where.push(`role ${item.detail.role}`);
  if (item.kind === 'approval') {
    const what = item.detail.tool === 'file' ? 'File write' : 'Command';
    const category = item.detail.category ? ` (${item.detail.category})` : '';
    return `Approval needed${category}\n${where.join(' · ')}\n${what}: <code>${escapeHtml(item.prompt)}</code>`;
  }
  return `Decision needed\n${where.join(' · ')}\n${escapeHtml(item.prompt)}`;
}

/** Telegram messages take at most 4096 chars; text is sent in pieces under this. */
export const TELEGRAM_CHUNK = 4000;

/** The report as a Telegram message: a conversation's reply as is, a run as a short digest. */
export function telegramReportText(r: RunReport): string {
  if (r.reply !== undefined && r.nodes.every((n) => n.status === 'completed')) return r.reply;
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
interface Message {
  message_id: number;
  text?: string;
  /** Unix seconds when it was sent. */
  date?: number;
  chat: { id: number; type?: string };
}

/** A Bot API error with what Telegram says about it. */
class TelegramApiError extends Error {
  constructor(
    method: string,
    readonly status: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`telegram ${method} failed: ${description}`);
  }
}
interface Update {
  update_id: number;
  callback_query?: CallbackQuery;
  message?: Message;
}

/** The Telegram channel: a channel that can also send any text to its chat. */
export interface TelegramChannel extends Channel {
  id: 'telegram';
  /** The chat it talks to. */
  readonly chatId: number;
  /** Sends plain text (HTML-escaped, split under Telegram's limit) to the chat. */
  send(text: string): Promise<void>;
}

/** Whether a channel is the Telegram one with `send` (a test may inject a bare one). */
export const isTelegramChannel = (c: Channel): c is TelegramChannel =>
  c.id === 'telegram' && typeof (c as Partial<TelegramChannel>).send === 'function';

/** Telegram Bot API over `fetch`: inline Approve/Deny buttons, long polling for the answers. */
export function telegramChannel(o: TelegramOptions): TelegramChannel {
  const base = `${o.apiBase ?? 'https://api.telegram.org/bot'}${o.token}`;
  const doFetch = o.fetch ?? fetch;
  const messages = new Map<string, { messageId: number; text: string }>();
  const tokens = new Map<string, InboxId>();
  const resolveToken = async (t: string): Promise<InboxId | undefined> =>
    tokens.get(t) ?? (await o.lookup?.(t));
  let answer: ((id: InboxId, a: { approved: boolean; note?: string }) => Promise<void>) | undefined;
  let onText: ((chatId: number, text: string) => Promise<void>) | undefined;
  let polling: AbortController | undefined;
  let offset = o.offset ?? 0;

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
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!res.ok || !json.ok)
      throw new TelegramApiError(
        method,
        res.status,
        json.description ?? String(res.status),
        json.parameters?.retry_after,
      );
    return json.result as T;
  }

  /**
   * Sends `text` in pieces under the limit, escaping each piece after the split so no HTML
   * entity is ever cut; a rate-limited piece waits `retry_after` and is sent again (never
   * the earlier pieces); a piece Telegram cannot parse goes out as plain text.
   */
  async function sendText(text: string, parseMode?: 'HTML'): Promise<void> {
    const pieces =
      parseMode === 'HTML'
        ? chunkBy(text, TELEGRAM_CHUNK, (s) => escapeHtml(s).length)
        : chunkText(text, TELEGRAM_CHUNK);
    for (const raw of pieces) {
      const piece = parseMode === 'HTML' ? escapeHtml(raw) : raw;
      for (let attempt = 0; ; attempt++) {
        try {
          await api('sendMessage', {
            chat_id: o.chatId,
            text: piece,
            ...(parseMode ? { parse_mode: parseMode } : {}),
          });
          break;
        } catch (e) {
          if (e instanceof TelegramApiError && e.status === 429 && attempt < 3) {
            await new Promise((r) => setTimeout(r, Math.min(e.retryAfter ?? 1, 30) * 1000));
            continue;
          }
          if (e instanceof TelegramApiError && e.status === 400 && parseMode) {
            await api('sendMessage', { chat_id: o.chatId, text: raw });
            break;
          }
          throw e;
        }
      }
    }
  }

  /** A pre-escaped HTML digest: pieces are already safe, only the split matters. */
  async function sendDigest(html: string): Promise<void> {
    for (const piece of chunkText(html, TELEGRAM_CHUNK))
      await api('sendMessage', { chat_id: o.chatId, text: piece, parse_mode: 'HTML' });
  }

  async function handleMessage(m: Message): Promise<void> {
    if (m.chat.id !== o.chatId) {
      o.log(`[telegram] ignored message from chat ${m.chat.id}`);
      return;
    }
    // text is a turn for the orchestrator (with write-capable tools): private chats only
    if (m.chat.type !== undefined && m.chat.type !== 'private') {
      o.log(
        `[telegram] ignored message from a ${m.chat.type} chat: text is accepted in private chats only`,
      );
      return;
    }
    const text = (m.text ?? '').trim();
    if (!text) return;
    if (text === '/help' || text === '/start') return sendText(HELP);
    if (text === '/status') return sendText((await o.status?.()) ?? 'No status available.');
    if (!onText) return sendText('Nobody is listening for messages here yet.');
    await api('sendChatAction', { chat_id: o.chatId, action: 'typing' }).catch(() => undefined);
    await onText(m.chat.id, text);
  }

  async function handle(u: Update): Promise<void> {
    if (u.message) return handleMessage(u.message);
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

  // the first batch after a start may hold what piled up while the daemon was down: only the
  // last text is a turn (the rest were meant for a daemon that was not there), and the chat
  // is told
  let firstBatch = true;
  let startedAt = 0; // unix seconds when polling began: older texts were sent to a daemon that was down
  async function backlog(updates: Update[]): Promise<Update[]> {
    if (!firstBatch) return updates;
    firstBatch = false;
    const isText = (u: Update) =>
      u.message?.text !== undefined &&
      u.message.chat.id === o.chatId &&
      (u.message.chat.type === undefined || u.message.chat.type === 'private') &&
      !u.message.text.startsWith('/') &&
      typeof u.message.date === 'number' &&
      u.message.date < startedAt - 2;
    const texts = updates.filter(isText);
    if (texts.length <= 1) return updates;
    const keep = texts[texts.length - 1];
    await sendText(
      `${texts.length - 1} earlier message(s) arrived while I was away; answering the last one.`,
    ).catch(() => undefined);
    return updates.filter((u) => !isText(u) || u === keep);
  }

  async function poll(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const fetched = await api<Update[]>(
          'getUpdates',
          {
            offset,
            timeout: o.pollTimeoutSeconds ?? 30,
            allowed_updates: ['callback_query', 'message'],
          },
          signal,
        );
        for (const u of fetched) offset = Math.max(offset, u.update_id + 1);
        const updates = await backlog(fetched);
        for (const u of updates) {
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
    chatId: o.chatId,
    send: (text) => sendText(text, 'HTML'),
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
      const text = telegramReportText(r);
      // a conversation reply is raw text (escaped per piece); a digest is already HTML
      if (r.reply !== undefined && text === r.reply) await sendText(text, 'HTML');
      else await sendDigest(text);
    },
    say: (text) => sendText(text),
    onAnswer(cb) {
      answer = cb;
    },
    onMessage(cb) {
      onText = cb;
    },
    async start() {
      startedAt = Math.floor(Date.now() / 1000);
      polling = new AbortController();
      void poll(polling.signal);
    },
    async stop() {
      polling?.abort();
      polling = undefined;
    },
  };
}
