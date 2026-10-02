import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { fakeBotApi, start } from './fake-bot-api.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
let fake: Awaited<ReturnType<typeof fakeBotApi>> | undefined;
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  await fake?.close();
  fake = undefined;
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function daemonWith(o: { env?: NodeJS.ProcessEnv; telegram?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tgpair-'));
  tmp.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const lines: string[] = [];
  const d = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    env: o.env ?? { SHIBAOX_TELEGRAM_TOKEN: 'tok-1' },
    log: (l) => lines.push(l),
    vault: join(dir, 'vault'),
    telegramApiBase: fake?.apiBase,
    config: {
      max_concurrent_runs: 2,
      approval_timeout_minutes: 1,
      channels: {
        macos: { enabled: false },
        github: { enabled: false },
        ...(o.telegram
          ? { telegram: { bot_token_env: 'SHIBAOX_TELEGRAM_TOKEN', chat_id: 5, workflow: 'chat' } }
          : {}),
      },
    } as never,
  });
  daemons.push(d);
  return { d, home, lines };
}

describe('pairing Telegram from the daemon', () => {
  it('the first /start after an empty poll pairs: daemon.yaml, the channel, notifications', async () => {
    fake = await fakeBotApi({ emptyPolls: 1 });
    fake.push(start(10, 42));
    const { d, home, lines } = daemonWith();
    await d.start();
    writeFileSync(home.config, '# mine\nmax_concurrent_runs: 2\n');
    const r = await d.pairTelegram();
    expect(r).toMatchObject({ paired: true, chatId: 42, from: 'andre' });
    const text = readFileSync(home.config, 'utf8');
    expect(text).toContain('# mine');
    expect(text).toMatch(/chat_id: 42/);
    expect(d.config.channels.telegram).toMatchObject({
      chat_id: 42,
      bot_token_env: 'SHIBAOX_TELEGRAM_TOKEN',
      workflow: 'chat',
    });
    expect(d.health().channels).toContain('telegram');
    expect(lines).toContain('telegram: paired with chat 42');
    expect(lines.join('\n')).not.toContain('tok-1');
    // long polling, messages only, and the pairing's update is never seen again by the channel
    const polls = fake.calls.filter((c) => c.method === 'getUpdates');
    expect(polls[0]?.body).toMatchObject({ timeout: 20, allowed_updates: ['message'] });
    expect(polls[0]?.token).toBe('tok-1');
    // the channel's own polls (callbacks and messages) start past the pairing's update
    const channelPolls = () =>
      (fake?.calls ?? []).filter(
        (c) =>
          c.method === 'getUpdates' &&
          (c.body.allowed_updates as string[] | undefined)?.length === 2,
      );
    await vi.waitFor(() => expect(channelPolls().length).toBeGreaterThan(0));
    expect(channelPolls().every((c) => Number(c.body.offset) >= 11)).toBe(true);
    // nothing answered /start as a turn
    expect(fake.calls.some((c) => c.method === 'sendMessage')).toBe(false);
    // an approval goes to the paired chat
    await d.inbox.ask({ runId: 'r1', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' });
    await vi.waitFor(() =>
      expect(fake?.calls.find((c) => c.method === 'sendMessage')?.body.chat_id).toBe(42),
    );
  });

  it('prefers a /start over another message of the same batch', async () => {
    fake = await fakeBotApi();
    fake.push(start(1, 7, 'hello'));
    fake.push(start(2, 42));
    const { d } = daemonWith();
    await d.start();
    expect(await d.pairTelegram({ timeoutMs: 3000 })).toMatchObject({ paired: true, chatId: 42 });
  });

  it('re-pairs a configured channel: it restarts on the new chat', async () => {
    fake = await fakeBotApi();
    const { d } = daemonWith({ telegram: true });
    await d.start();
    expect(d.health().channels).toContain('telegram');
    fake.push(start(3, 99));
    expect(await d.pairTelegram({ timeoutMs: 3000 })).toMatchObject({ paired: true, chatId: 99 });
    await d.inbox.ask({ runId: 'r1', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' });
    await vi.waitFor(() =>
      expect(fake?.calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.chat_id).toBe(99),
    );
  });

  it('a Conflict from another poller is retried: the /start after it pairs', async () => {
    fake = await fakeBotApi({ conflicts: 2 });
    fake.push(start(10, 42));
    const { d } = daemonWith();
    await d.start();
    const r = await d.pairTelegram({ timeoutMs: 20_000 });
    expect(r).toMatchObject({ paired: true, chatId: 42 });
    expect(fake.calls.filter((c) => c.method === 'getUpdates').length).toBeGreaterThanOrEqual(3);
  });
  it('a Conflict that never clears names the cause: another program uses the bot', async () => {
    fake = await fakeBotApi({ conflicts: 1000 });
    const { d } = daemonWith();
    await d.start();
    const r = await d.pairTelegram({ timeoutMs: 2_500 });
    expect(r.paired).toBe(false);
    expect(r.paired === false && r.reason).toMatch(/another program is polling this bot/);
    expect(r.paired === false && r.reason).toMatch(/BotFather/);
  });
  it('no message before the timeout: not paired, nothing written', async () => {
    fake = await fakeBotApi();
    const { d, home } = daemonWith();
    await d.start();
    const r = await d.pairTelegram({ timeoutMs: 300 });
    expect(r).toMatchObject({
      paired: false,
      reason: expect.stringMatching(/^no message received/),
    });
    expect(existsSync(home.config)).toBe(false);
    expect(d.config.channels.telegram).toBeUndefined();
  });

  it('without a token it says so and calls nothing', async () => {
    fake = await fakeBotApi();
    const { d } = daemonWith({ env: {} });
    await d.start();
    expect(await d.pairTelegram({ timeoutMs: 300 })).toEqual({ paired: false, reason: 'no token' });
    expect(fake.calls).toEqual([]);
  });

  it('one pairing at a time (409 pairing); stopping the daemon ends the wait', async () => {
    fake = await fakeBotApi();
    const { d } = daemonWith();
    await d.start();
    const first = d.pairTelegram({ timeoutMs: 10_000 });
    await expect(d.pairTelegram({ timeoutMs: 100 })).rejects.toMatchObject({
      status: 409,
      code: 'pairing',
    });
    const t0 = Date.now();
    await d.stop({ force: true });
    expect(await first).toMatchObject({ paired: false });
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe('sending to the paired chat', () => {
  it('sends escaped text to the configured chat, split under the limit', async () => {
    fake = await fakeBotApi();
    const { d } = daemonWith({ telegram: true });
    await d.start();
    expect(await d.telegramSend('a <b> & c')).toEqual({ sent: true, chatId: 5 });
    const sent = () => (fake?.calls ?? []).filter((c) => c.method === 'sendMessage');
    expect(sent()[0]?.body).toMatchObject({
      chat_id: 5,
      text: 'a &lt;b&gt; &amp; c',
      parse_mode: 'HTML',
    });
    await d.telegramSend('x'.repeat(9000));
    expect(
      sent()
        .slice(1)
        .map((c) => String(c.body.text).length),
    ).toEqual([4000, 4000, 1000]);
  });

  it('not paired, or no token: says why and sends nothing', async () => {
    fake = await fakeBotApi();
    const a = daemonWith();
    await a.d.start();
    expect(await a.d.telegramSend('hi')).toEqual({ sent: false, reason: 'not paired' });
    const b = daemonWith({ env: {}, telegram: true });
    await b.d.start();
    expect(await b.d.telegramSend('hi')).toEqual({ sent: false, reason: 'no token' });
    expect(fake.calls.some((c) => c.method === 'sendMessage')).toBe(false);
  });
});
