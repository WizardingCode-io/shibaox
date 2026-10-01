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
};

const checks = (o: Partial<PluginChecks> = {}): PluginChecks => ({
  higgsfield: async () => hfOff,
  which: async () => undefined,
  env: {},
  decider: async () => ({ kind: 'none', usable: false, reason: 'no decision tier' }),
  ...o,
});

describe('plugins', () => {
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
    expect(hf?.brings).toEqual({ connectors: ['higgsfield'], skills: ['higgsfield'] });
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
});
