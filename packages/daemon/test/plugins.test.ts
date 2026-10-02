import { describe, expect, it } from 'vitest';
import type { HiggsfieldView } from '../src/higgsfield.js';
import { type PluginChecks, pluginsStatus } from '../src/plugins.js';

const hfOff: HiggsfieldView = {
  cli: { installed: false },
  loggedIn: false,
  mcp: 'unreachable',
  signupUrl: 'https://higgsfield.ai/?ref=x',
  installCommand: 'curl … | sh',
  site: 'https://higgsfield.ai',
  api: { keySet: false },
  mode: 'auto',
  effective: 'none',
};

const checks = (o: Partial<PluginChecks> = {}): PluginChecks => ({
  higgsfield: async () => hfOff,
  which: async () => undefined,
  env: {},
  decider: async () => ({ kind: 'none', usable: false, reason: 'no decision tier' }),
  telegram: () => ({ paired: false, running: false }),
  ...o,
});

describe('plugins', () => {
  it('Telegram: ready only with the token, a paired chat and the channel running', async () => {
    const tg = async (o: Partial<PluginChecks>) =>
      (await pluginsStatus(checks(o))).find((r) => r.id === 'telegram');
    // the token alone is not Ready: nothing is paired
    const tokenOnly = await tg({ env: { SHIBAOX_TELEGRAM_TOKEN: 't' } });
    expect(tokenOnly?.status).toBe('partial');
    expect(tokenOnly?.checks).toEqual([
      { label: 'Bot token (SHIBAOX_TELEGRAM_TOKEN)', ok: true },
      { label: 'Paired with a chat', ok: false },
      { label: 'Channel running', ok: false },
    ]);
    const paired = await tg({
      env: { SHIBAOX_TELEGRAM_TOKEN: 't' },
      telegram: () => ({ paired: true, chatId: 42, running: true }),
    });
    expect(paired?.status).toBe('ready');
    expect(paired?.checks[1]).toEqual({ label: 'Paired with a chat', ok: true, detail: 'chat 42' });
    expect(paired?.actions.map((a) => a.id)).toEqual(['pair', 'test', 'botfather', 'docs']);
    expect(paired?.actions.slice(0, 2)).toEqual([
      { id: 'pair', label: 'Pair with my Telegram' },
      { id: 'test', label: 'Send a test message' },
    ]);
    expect(paired?.brings).toEqual({ connectors: [], skills: [], tools: ['telegram_send'] });
    const notRunning = await tg({
      env: { SHIBAOX_TELEGRAM_TOKEN: 't' },
      telegram: () => ({ paired: true, chatId: 42, running: false }),
    });
    expect(notRunning?.status).toBe('partial');
  });

  it('everything off when nothing is there', async () => {
    const rows = await pluginsStatus(checks());
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['higgsfield', 'off'],
      ['github', 'off'],
      ['telegram', 'off'],
      ['typesafe', 'off'],
    ]);
    const hf = rows[0];
    expect(hf?.actions.map((a) => a.id)).toEqual(['install', 'login', 'signup', 'open']);
    expect(hf?.actions.find((a) => a.id === 'signup')?.href).toBe('https://higgsfield.ai/?ref=x');
    expect(hf?.actions.find((a) => a.id === 'login')?.href).toBe('/integrations/higgsfield/login');
    expect(hf?.actions.find((a) => a.id === 'install')?.command).toBe('curl … | sh');
    expect(hf?.brings).toEqual({
      connectors: ['higgsfield'],
      skills: ['higgsfield'],
      builtin: ['higgsfield'],
    });
  });

  it('ready when every check passes, partial when some do', async () => {
    const rows = await pluginsStatus(
      checks({
        higgsfield: async () => ({
          ...hfOff,
          cli: { installed: true, version: '1.2.3' },
          loggedIn: true,
          account: { email: 'a@b.c', plan: 'pro', credits: 12 },
          mcp: 'ok',
        }),
        which: async (cmd) => (cmd === 'gh' ? '/opt/homebrew/bin/gh' : undefined),
        env: { GITHUB_TOKEN: 'x', TYPESAFE_API_KEY: 'k' },
        decider: async () => ({ kind: 'jev', ref: 'jev-latest', usable: true }),
      }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.higgsfield?.status).toBe('ready');
    expect(by.higgsfield?.checks[0]).toMatchObject({ ok: true, detail: '1.2.3' });
    expect(by.github?.status).toBe('ready');
    expect(by.github?.keys).toEqual([
      { name: 'GH_TOKEN', present: false },
      { name: 'GITHUB_TOKEN', present: true },
    ]);
    expect(by.telegram?.status).toBe('off');
    expect(by.typesafe?.status).toBe('ready');
    const partial = await pluginsStatus(checks({ env: { TYPESAFE_API_KEY: 'k' } }));
    expect(partial.find((r) => r.id === 'typesafe')?.status).toBe('partial');
  });

  it('a failing probe is a failed check, never an error', async () => {
    const rows = await pluginsStatus(
      checks({
        higgsfield: async () => {
          throw new Error('boom');
        },
        which: async () => {
          throw new Error('boom');
        },
      }),
    );
    expect(rows.find((r) => r.id === 'higgsfield')?.status).toBe('off');
    expect(rows.find((r) => r.id === 'github')?.status).toBe('off');
  });

  it('Higgsfield has two modes; with only the account the account is on top', async () => {
    const rows = await pluginsStatus(
      checks({
        higgsfield: async () => ({
          ...hfOff,
          cli: { installed: true, version: '1.2.3' },
          loggedIn: true,
          account: { email: 'a@b.c', plan: 'pro', credits: 12 },
          mcp: 'ok',
          effective: 'account',
        }),
      }),
    );
    const hf = rows[0];
    expect(hf?.mode).toEqual({ configured: 'auto', effective: 'account' });
    expect(hf?.modes?.map((m) => [m.id, m.active, m.status])).toEqual([
      ['account', true, 'ready'],
      ['api', false, 'off'],
    ]);
    expect(hf?.status).toBe('ready');
    expect(hf?.checks.map((c) => c.label)).toEqual(['CLI installed', 'Logged in', 'MCP reachable']);
    const api = hf?.modes?.[1];
    expect(api?.checks).toEqual([
      { label: 'API key saved', ok: false },
      { label: 'API key valid', ok: false, detail: 'no key' },
    ]);
    expect(api?.keys).toEqual([{ name: 'HIGGSFIELD_API_KEY', present: false }]);
    expect(api?.actions).toEqual([
      { id: 'connect_key', label: 'Connect API key', href: 'https://open.higgsfield.ai/api-keys' },
      { id: 'docs', label: 'API docs', href: 'https://docs.higgsfield.ai/docs' },
    ]);
    expect(api?.brings).toEqual({
      connectors: [],
      skills: ['higgsfield', 'higgsfield-app'],
      builtin: ['higgsfield', 'higgsfield-app'],
      tools: [
        'higgsfield_api_generate',
        'higgsfield_api_status',
        'higgsfield_api_cancel',
        'higgsfield_api_upload',
      ],
    });
  });

  it('a valid key in auto puts the API on top, ready, with the key listed', async () => {
    const rows = await pluginsStatus(
      checks({
        env: { HIGGSFIELD_API_KEY: 'id:secret' },
        higgsfield: async () => ({
          ...hfOff,
          api: { keySet: true, valid: true, status: 404 },
          effective: 'api',
        }),
      }),
    );
    const hf = rows[0];
    expect(hf?.status).toBe('ready');
    expect(hf?.mode).toEqual({ configured: 'auto', effective: 'api' });
    expect(hf?.keys).toEqual([{ name: 'HIGGSFIELD_API_KEY', present: true }]);
    expect(hf?.checks).toEqual([
      { label: 'API key saved', ok: true },
      { label: 'API key valid', ok: true, detail: 'accepted' },
    ]);
    expect(hf?.actions[0]).toMatchObject({ id: 'connect_key', label: 'Manage API key' });
    expect(hf?.modes?.find((m) => m.active)?.id).toBe('api');
    expect(JSON.stringify(rows)).not.toContain('id:secret');
    const refused = await pluginsStatus(
      checks({
        env: { HIGGSFIELD_API_KEY: 'id:secret' },
        higgsfield: async () => ({
          ...hfOff,
          api: { keySet: true, valid: false, status: 401 },
          effective: 'api',
        }),
      }),
    );
    expect(refused[0]?.status).toBe('partial');
    expect(refused[0]?.checks[1]).toEqual({
      label: 'API key valid',
      ok: false,
      detail: 'rejected by Higgsfield (401)',
    });
    const unknown = await pluginsStatus(
      checks({
        env: { HIGGSFIELD_API_KEY: 'id:secret' },
        higgsfield: async () => ({ ...hfOff, api: { keySet: true }, effective: 'api' }),
      }),
    );
    expect(unknown[0]?.checks[1]).toMatchObject({ ok: false, detail: 'not checked' });
  });

  it('api chosen without a key: the API is on top and off, even when the account works', async () => {
    const rows = await pluginsStatus(
      checks({
        higgsfield: async () => ({
          ...hfOff,
          cli: { installed: true },
          loggedIn: true,
          mcp: 'ok',
          mode: 'api',
          effective: 'none',
        }),
      }),
    );
    const hf = rows[0];
    expect(hf?.status).toBe('off');
    expect(hf?.mode).toEqual({ configured: 'api', effective: 'none' });
    expect(hf?.modes?.find((m) => m.active)?.id).toBe('api');
    expect(hf?.modes?.find((m) => m.id === 'account')?.status).toBe('ready');
  });

  it('other plugins have no modes', async () => {
    const rows = await pluginsStatus(checks());
    for (const r of rows.filter((r) => r.id !== 'higgsfield')) {
      expect(r.modes).toBeUndefined();
      expect(r.mode).toBeUndefined();
    }
  });
});
