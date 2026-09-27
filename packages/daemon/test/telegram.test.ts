import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inboxToken, telegramChannel } from '../src/channels/telegram.js';
import type { InboxItem } from '../src/inbox.js';
import { chunkBy } from '../src/runs/report.js';

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** A fake Bot API: records calls, serves queued updates to getUpdates. */
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  let messageId = 100;
  let failNext: Record<string, unknown> | undefined;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      calls.push({ method, body });
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result }));
      };
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        const pending = updates.filter((u) => (u as { update_id: number }).update_id >= offset);
        return reply(pending);
      }
      if (method === 'sendMessage' && failNext) {
        const err = failNext;
        failNext = undefined;
        res.writeHead(Number(err.error_code ?? 400), { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, ...err }));
      }
      if (method === 'sendMessage') return reply({ message_id: ++messageId });
      return reply(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    apiBase: `http://127.0.0.1:${port}/bot`,
    calls,
    push(update: unknown) {
      updates.push(update);
    },
    failNext(err: Record<string, unknown>) {
      failNext = err;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const approval: InboxItem = {
  id: 'approval:a1',
  kind: 'approval',
  runId: 'run-12345678',
  nodeId: 'implement',
  at: 'x',
  prompt: 'git push origin main',
  detail: { role: 'backend', program: 'git', category: 'push' },
};
const human: InboxItem = {
  id: 'human:run-1:ship',
  kind: 'human',
  runId: 'run-1',
  nodeId: 'ship',
  at: 'x',
  prompt: 'Ship it?',
  detail: { action: 'ship' },
};

const message = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: {
    message_id: 200 + id,
    text,
    chat: { id: chatId, type: 'private' },
    from: { id: chatId },
  },
});
const callback = (id: number, chatId: number, data: string) => ({
  update_id: id,
  callback_query: { id: `cb${id}`, data, message: { message_id: 101, chat: { id: chatId } } },
});

let fake: Awaited<ReturnType<typeof fakeTelegram>> | undefined;
let channel: ReturnType<typeof telegramChannel> | undefined;
afterEach(async () => {
  await channel?.stop?.();
  await fake?.close();
  channel = undefined;
  fake = undefined;
});

describe('telegram channel', () => {
  it('notify sends the item with Approve and Deny buttons, never file contents', async () => {
    fake = await fakeTelegram();
    channel = telegramChannel({ token: 't', chatId: 7, apiBase: fake.apiBase, log: () => {} });
    await channel.notify(approval);
    await channel.notify(human);
    const sent = fake.calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.body).toMatchObject({
      chat_id: 7,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: `approve:${inboxToken('approval:a1')}` },
            { text: 'Deny', callback_data: `deny:${inboxToken('approval:a1')}` },
          ],
        ],
      },
    });
    expect(String(sent[0]?.body.text)).toContain('Approval needed');
    expect(String(sent[0]?.body.text)).toContain('Run run-1234 · node implement · role backend');
    expect(String(sent[0]?.body.text)).toContain('<code>git push origin main</code>');
    expect(String(sent[1]?.body.text)).toContain('Decision needed');
    expect(String(sent[1]?.body.text)).toContain('Ship it?');
    // Telegram limits callback_data to 64 bytes, whatever the inbox id length
    const long: InboxItem = {
      ...human,
      id: `human:${'x'.repeat(36)}:approve-deploy-to-production`,
    };
    await channel.notify(long);
    const last = fake.calls.at(-1);
    const markup = last?.body.reply_markup as
      | { inline_keyboard: { callback_data: string }[][] }
      | undefined;
    const kb = markup?.inline_keyboard[0];
    for (const b of kb ?? []) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });

  it('a callback from the configured chat answers the item and acknowledges', async () => {
    fake = await fakeTelegram();
    const answers: unknown[] = [];
    channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: () => {},
      pollTimeoutSeconds: 0,
    });
    channel.onAnswer?.(async (id, a) => {
      answers.push([id, a]);
    });
    await channel.notify(approval);
    await channel.start?.();
    fake.push(callback(1, 7, `approve:${inboxToken('approval:a1')}`));
    await vi.waitFor(() => expect(answers).toEqual([['approval:a1', { approved: true }]]));
    await vi.waitFor(() =>
      expect(fake?.calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({
        callback_query_id: 'cb1',
        text: 'Approved',
      }),
    );
    // the same update is not delivered twice (offset advances)
    fake.push(callback(2, 7, `deny:${inboxToken('approval:a1')}`));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(answers[1]).toEqual(['approval:a1', { approved: false }]);
  });

  it('ignores callbacks from other chats', async () => {
    fake = await fakeTelegram();
    const answers: unknown[] = [];
    const logs: string[] = [];
    channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: (l) => logs.push(l),
      pollTimeoutSeconds: 0,
    });
    channel.onAnswer?.(async (id, a) => {
      answers.push([id, a]);
    });
    await channel.start?.();
    fake.push(callback(1, 999, `approve:${inboxToken('approval:a1')}`));
    await vi.waitFor(() =>
      expect(logs.some((l) => l.includes('ignored callback from chat 999'))).toBe(true),
    );
    await vi.waitFor(() =>
      expect(fake?.calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({
        text: 'Not allowed',
      }),
    );
    expect(answers).toEqual([]);
  });

  it('resolved edits the original message', async () => {
    fake = await fakeTelegram();
    channel = telegramChannel({ token: 't', chatId: 7, apiBase: fake.apiBase, log: () => {} });
    await channel.notify(approval);
    await channel.resolved?.(approval, { approved: true, via: 'cli' });
    const edit = fake.calls.find((c) => c.method === 'editMessageText');
    expect(edit?.body).toMatchObject({ chat_id: 7, message_id: 101 });
    expect(String(edit?.body.text)).toContain('Approved via cli');
  });

  it('an answer that fails as already resolved acknowledges "Already answered" (token via lookup after a restart)', async () => {
    fake = await fakeTelegram();
    channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: () => {},
      pollTimeoutSeconds: 0,
      lookup: async (t) => (t === inboxToken('approval:a1') ? 'approval:a1' : undefined),
    });
    const { AlreadyResolvedError } = await import('../src/inbox.js');
    channel.onAnswer?.(async (id) => {
      throw new AlreadyResolvedError(id);
    });
    await channel.start?.();
    fake.push(callback(1, 7, `approve:${inboxToken('approval:a1')}`));
    await vi.waitFor(() =>
      expect(fake?.calls.find((c) => c.method === 'answerCallbackQuery')?.body).toMatchObject({
        text: 'Already answered',
      }),
    );
  });
});

describe('telegram text', () => {
  it('a text message from the configured chat reaches onMessage; other chats are ignored', async () => {
    fake = await fakeTelegram();
    const logs: string[] = [];
    const received: [number, string][] = [];
    channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: (l) => logs.push(l),
      pollTimeoutSeconds: 0,
    });
    channel.onMessage?.(async (chatId, text) => {
      received.push([chatId, text]);
    });
    await channel.start?.();
    fake.push(message(1, 9, 'hack'));
    // a group with the configured id: text is taken from private chats only
    fake.push({
      update_id: 2,
      message: { message_id: 202, text: 'from the group', chat: { id: 7, type: 'group' } },
    });
    fake.push(message(3, 7, 'olá'));
    await vi.waitFor(() => expect(received).toEqual([[7, 'olá']]));
    expect(logs.some((l) => l.includes('ignored message from chat 9'))).toBe(true);
    expect(logs.some((l) => l.includes('group'))).toBe(true);
    expect(fake.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(fake.calls.find((c) => c.method === 'sendChatAction')?.body).toMatchObject({
      chat_id: 7,
      action: 'typing',
    });
    const poll = fake.calls.find((c) => c.method === 'getUpdates');
    expect(poll?.body.allowed_updates).toEqual(['callback_query', 'message']);
  });

  it('/status and /help answer from the channel itself', async () => {
    fake = await fakeTelegram();
    channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: () => {},
      pollTimeoutSeconds: 0,
      status: async () => 'daemon 0.0.1 · 1 running',
    });
    const received: string[] = [];
    channel.onMessage?.(async (_c, text) => {
      received.push(text);
    });
    await channel.start?.();
    fake.push(message(1, 7, '/status'));
    fake.push(message(2, 7, '/help'));
    await vi.waitFor(() =>
      expect(fake?.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(2),
    );
    const sent = fake.calls.filter((c) => c.method === 'sendMessage');
    expect(String(sent[0]?.body.text)).toContain('daemon 0.0.1 · 1 running');
    expect(String(sent[1]?.body.text)).toContain('/status');
    expect(received).toEqual([]);
  });

  it('report sends a conversation reply as is and long text in pieces', async () => {
    fake = await fakeTelegram();
    channel = telegramChannel({ token: 't', chatId: 7, apiBase: fake.apiBase, log: () => {} });
    await channel.report?.({
      runId: 'r1',
      workflow: 'chat',
      status: 'completed',
      project: '/w',
      spentUsd: 0.01,
      nodes: [{ id: 'reply', status: 'completed' }],
      reply: 'a <b> & c',
    });
    await channel.report?.({
      runId: 'r2',
      workflow: 'chat',
      status: 'completed',
      project: '/w',
      spentUsd: 0.01,
      nodes: [{ id: 'reply', status: 'completed' }],
      reply: Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n'),
    });
    const sent = fake.calls.filter((c) => c.method === 'sendMessage');
    expect(sent[0]?.body).toMatchObject({
      chat_id: 7,
      text: 'a &lt;b&gt; &amp; c',
      parse_mode: 'HTML',
    });
    expect(sent.length).toBeGreaterThan(3);
    for (const s of sent) expect(String(s.body.text).length).toBeLessThanOrEqual(4000);
    await channel.say?.('plain');
    expect(fake.calls.at(-1)?.body).toMatchObject({ chat_id: 7, text: 'plain' });
  });

  it('escapes after chunking (no entity is ever split) and retries a rate-limited chunk', async () => {
    fake = await fakeTelegram();
    fake.failNext({
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 0 },
    });
    channel = telegramChannel({ token: 't', chatId: 7, apiBase: fake.apiBase, log: () => {} });
    await channel.report?.({
      runId: 'r',
      workflow: 'chat',
      status: 'completed',
      project: '/w',
      spentUsd: 0,
      nodes: [{ id: 'reply', status: 'completed' }],
      reply: '&'.repeat(6000),
    });
    const sent = fake.calls.filter((c) => c.method === 'sendMessage');
    // 6000 '&' → escaped in pieces: every piece is whole entities, none over the limit
    expect(sent.length).toBeGreaterThanOrEqual(3);
    for (const s of sent) {
      const text = String(s.body.text);
      expect(text.length).toBeLessThanOrEqual(4096);
      expect(text.replace(/&amp;/g, '')).toBe('');
    }
    // the first attempt was rate-limited and retried: one more call than pieces delivered
    const pieces = chunkBy('&'.repeat(6000), 4000, (s) => s.replace(/&/g, '&amp;').length).length;
    expect(sent.length).toBe(pieces + 1);
  });
});
