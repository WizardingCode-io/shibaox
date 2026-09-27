import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore } from '@shibaox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { telegramChannel } from '../src/channels/telegram.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { scaffoldOrg } from '../src/templates.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));

interface Call {
  method: string;
  body: Record<string, unknown>;
}
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: unknown[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = (req.url ?? '').split('/').pop() ?? '';
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      calls.push({ method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        return res.end(
          JSON.stringify({
            ok: true,
            result: updates.filter((u) => (u as { update_id: number }).update_id >= offset),
          }),
        );
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    apiBase: `http://127.0.0.1:${port}/bot`,
    calls,
    push: (u: unknown) => updates.push(u),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
/** The spec of a run's input (helper for ordering by content). */
const await0 = async (store: MemoryEventStore, runId: string): Promise<string> => {
  const created = (await store.read(runId))[0];
  return created?.type === 'RunCreated' ? String(created.input.spec ?? '') : '';
};
const message = (id: number, chatId: number, text: string) => ({
  update_id: id,
  message: { message_id: 200 + id, text, chat: { id: chatId, type: 'private' } },
});

const tmp: string[] = [];
const daemons: Daemon[] = [];
let fake: Awaited<ReturnType<typeof fakeTelegram>> | undefined;
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  await fake?.close();
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('talking to the orchestrator from Telegram', () => {
  it('a text message becomes a chat run with the Telegram origin and the thread; the reply comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgd-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const project = join(dir, 'proj');
    cpSync(sample, project, { recursive: true });
    fake = await fakeTelegram();
    const store = new MemoryEventStore();
    const channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: () => {},
      pollTimeoutSeconds: 0,
    });
    const daemon = new Daemon({
      home: homePaths({ SHIBAOX_HOME: join(dir, 'home') }),
      store,
      channels: [channel],
      env: {},
      log: () => {},
      vault: join(dir, 'vault'),
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: {
          macos: { enabled: false },
          telegram: {
            bot_token_env: 'X',
            chat_id: 7,
            org: join(dir, 'org'),
            project,
            workflow: 'chat',
            adapter: 'mock',
          },
        },
      },
    });
    daemons.push(daemon);
    await daemon.start();
    fake.push(message(1, 7, 'olá'));
    await vi.waitFor(async () => expect(await daemon.runs.list()).toHaveLength(1));
    const [first] = await daemon.runs.list();
    expect(first).toMatchObject({ workflow: 'chat', origin: 'telegram:7' });
    await vi.waitFor(() =>
      expect(fake?.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1),
    );
    const reply = fake.calls.find((c) => c.method === 'sendMessage');
    expect(String(reply?.body.text)).toContain('mock assistant');
    // two quick messages: the second waits for the first's answer, then carries it
    fake.push(message(2, 7, 'e agora?'));
    fake.push(message(3, 7, 'e depois?'));
    await vi.waitFor(async () => expect(await daemon.runs.list()).toHaveLength(3));
    const runs = await daemon.runs.list();
    const specs = new Map<string, string>();
    for (const r of runs) specs.set(r.runId, await await0(store, r.runId));
    const second = runs.find((r) => specs.get(r.runId) === 'e agora?');
    const third = runs.find((r) => specs.get(r.runId) === 'e depois?');
    const thirdCreated = (await store.read(third?.runId ?? ''))[0];
    expect(thirdCreated?.type === 'RunCreated' && thirdCreated.input).toMatchObject({
      spec: 'e depois?',
      messages: [
        { role: 'user', content: 'olá' },
        { role: 'assistant', content: expect.stringContaining('mock assistant') },
        { role: 'user', content: 'e agora?' },
        { role: 'assistant', content: expect.stringContaining('mock assistant') },
      ],
    });
    const created = (await store.read(second?.runId ?? ''))[0];
    expect(created?.type === 'RunCreated' && created.input).toMatchObject({
      spec: 'e agora?',
      messages: [
        { role: 'user', content: 'olá' },
        { role: 'assistant', content: expect.stringContaining('mock assistant') },
      ],
    });
  });

  it('without org and project in daemon.yaml the text gets an explanation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgd-'));
    tmp.push(dir);
    fake = await fakeTelegram();
    const channel = telegramChannel({
      token: 't',
      chatId: 7,
      apiBase: fake.apiBase,
      log: () => {},
      pollTimeoutSeconds: 0,
    });
    const daemon = new Daemon({
      home: homePaths({ SHIBAOX_HOME: join(dir, 'home') }),
      store: new MemoryEventStore(),
      channels: [channel],
      env: {},
      log: () => {},
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: {
          macos: { enabled: false },
          telegram: { bot_token_env: 'X', chat_id: 7, workflow: 'chat' },
        },
      },
    });
    daemons.push(daemon);
    await daemon.start();
    fake.push(message(1, 7, 'olá'));
    await vi.waitFor(() =>
      expect(fake?.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1),
    );
    expect(String(fake.calls.find((c) => c.method === 'sendMessage')?.body.text)).toContain(
      'channels.telegram.org',
    );
    expect(await daemon.runs.list()).toEqual([]);
  });
});
