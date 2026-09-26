import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inboxToken, telegramChannel } from '../src/channels/telegram.js';
import type { InboxItem } from '../src/inbox.js';

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** A fake Bot API: records calls, serves queued updates to getUpdates. */
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  let messageId = 100;
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
