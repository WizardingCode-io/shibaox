import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
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

async function daemon(o: { local?: () => boolean } = {}) {
  fake = await fakeBotApi();
  const dir = mkdtempSync(join(tmpdir(), 'plugact-'));
  tmp.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const d = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    env: { SHIBAOX_TELEGRAM_TOKEN: 'tok-1', SHIBAOX_DAEMON_TOKEN: 'secret-1' },
    log: () => {},
    vault: join(dir, 'vault'),
    telegramApiBase: fake.apiBase,
    ...(o.local ? { localPeer: o.local } : {}),
    config: {
      max_concurrent_runs: 2,
      approval_timeout_minutes: 1,
      channels: { macos: { enabled: false }, github: { enabled: false } },
      ...(o.local
        ? { listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' } }
        : {}),
    } as never,
  });
  daemons.push(d);
  await d.start();
  return { d, home, client: new DaemonClient(home.socket) };
}

describe('POST /plugins/:id/actions/:action', () => {
  it('telegram test: 409 not_paired before pairing; pair: 200 and daemon.yaml; then test sends', async () => {
    const { client, home } = await daemon();
    await expect(client.pluginAction('telegram', 'test')).rejects.toMatchObject({
      status: 409,
      code: 'not_paired',
    });
    fake?.push(start(1, 42));
    expect(await client.pluginAction('telegram', 'pair', { timeoutMs: 5000 })).toMatchObject({
      paired: true,
      chatId: 42,
    });
    expect(readFileSync(home.config, 'utf8')).toMatch(/chat_id: 42/);
    expect(await client.pluginAction('telegram', 'test')).toEqual({ sent: true, chatId: 42 });
    const sent = fake?.calls.filter((c) => c.method === 'sendMessage') ?? [];
    expect(sent.at(-1)?.body).toMatchObject({
      chat_id: 42,
      text: 'Shibaox ✓ test message from the app',
    });
  });

  it('a pairing with no message answers 200 with the reason', async () => {
    const { client, home } = await daemon();
    expect(await client.pluginAction('telegram', 'pair', { timeoutMs: 200 })).toMatchObject({
      paired: false,
      reason: expect.stringMatching(/^no message received/),
    });
    expect(existsSync(home.config)).toBe(false);
  });

  it('an unknown plugin or action is 404', async () => {
    const { client } = await daemon();
    await expect(client.pluginAction('nope', 'pair')).rejects.toMatchObject({ status: 404 });
    await expect(client.pluginAction('telegram', 'nope')).rejects.toMatchObject({ status: 404 });
  });

  it('pair is refused to another machine (403) and through a proxy; nothing written', async () => {
    let local = false;
    const { d, home } = await daemon({ local: () => local });
    const base = `http://127.0.0.1:${d.listenAddress()?.port}`;
    const post = (action: string, headers: Record<string, string> = {}) =>
      fetch(`${base}/plugins/telegram/actions/${action}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-1',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ timeoutMs: 200 }),
      });
    expect((await post('pair')).status).toBe(403);
    local = true;
    expect((await post('pair', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect(existsSync(home.config)).toBe(false);
    expect(fake?.calls).toEqual([]);
    // the test message writes nothing: allowed over the network (409 here: not paired)
    local = false;
    expect((await post('test')).status).toBe(409);
  });

  it('typesafe use_jev / routing_off / routing_on write the home org models.yaml', async () => {
    const { client, home } = await daemon();
    const org = (await client.defaultOrg()).root;
    const models = join(org, 'models.yaml');
    writeFileSync(
      models,
      'providers: {}\ntiers: { strong: anthropic/claude-sonnet-5, decision: openrouter/typesafe/jev-1.13 }\nroles: {}\ngates: {}\n',
    );
    expect(home.org).toBe(org);
    expect(await client.pluginAction('typesafe', 'use_jev')).toMatchObject({
      tiers: { decision: 'jev-latest' },
    });
    expect(readFileSync(models, 'utf8')).toContain('decision: jev-latest');
    expect(await client.pluginAction('typesafe', 'routing_off')).toMatchObject({
      routing: { jev: false },
    });
    expect(await client.pluginAction('typesafe', 'routing_on')).toMatchObject({
      routing: { jev: true },
    });
    await expect(client.pluginAction('typesafe', 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(client.pluginAction('typesafe', 'constructor')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('typesafe actions change the org: refused to another machine (403)', async () => {
    const { d, home } = await daemon({ local: () => false });
    const before = existsSync(join(home.org, 'models.yaml'))
      ? readFileSync(join(home.org, 'models.yaml'), 'utf8')
      : undefined;
    const r = await fetch(
      `http://127.0.0.1:${d.listenAddress()?.port}/plugins/typesafe/actions/routing_off`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret-1', 'content-type': 'application/json' },
        body: '{}',
      },
    );
    expect(r.status).toBe(403);
    const after = existsSync(join(home.org, 'models.yaml'))
      ? readFileSync(join(home.org, 'models.yaml'), 'utf8')
      : undefined;
    expect(after).toBe(before);
  });
});
