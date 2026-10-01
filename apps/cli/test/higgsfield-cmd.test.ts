import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, homePaths, scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmp: string[] = [];
const daemons: Daemon[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}
const run = (env: Record<string, string>, ...args: string[]) =>
  new Promise<Result>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { SHIBAOX_NO_AUTOSTART: '1', PATH: process.env.PATH ?? '', ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

async function daemon(env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-hf-'));
  tmp.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const d = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    log: () => {},
    version: '0.2.13',
    claudeInstalled: false,
    higgsfield: {
      exec: async () => ({ exitCode: 127, stdout: '', stderr: '' }),
      mcp: async () => 'unreachable',
      login: async () => ({ started: false }),
      apiCheck: async () => ({ valid: true, status: 404 }),
    },
  });
  daemons.push(d);
  await d.start();
  const cli = (...args: string[]) => run({ SHIBAOX_HOME: home.root, HOME: dir }, ...args);
  return { home, cli };
}

/** A fake Higgsfield API answering the key probe with `status`. */
async function api(status: number) {
  const s = createServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Key id:secret' ? status : 401);
    res.end('{}');
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe('shibaox plugins: Higgsfield modes', () => {
  it('prints the mode and both modes with their checks; --json keeps the whole row', async () => {
    const { cli } = await daemon({ HIGGSFIELD_API_KEY: 'id:secret' });
    const r = await cli('plugins');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mode auto → api/);
    expect(r.stdout).toMatch(/\[api\] active ready/);
    expect(r.stdout).toMatch(/\[account\] off/);
    expect(r.stdout).toMatch(/ok\s+API key valid/);
    expect(r.stdout).toMatch(/no\s+CLI installed/);
    expect(r.stdout).not.toContain('id:secret');
    const j = await cli('plugins', '--json');
    const hf = j.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: string; modes?: unknown[]; mode?: unknown })
      .find((row) => row.id === 'higgsfield');
    expect(hf?.modes).toHaveLength(2);
    expect(hf?.mode).toEqual({ configured: 'auto', effective: 'api' });
  });

  it('plugins higgsfield-mode writes daemon.yaml; a bad mode exits 1', async () => {
    const { cli, home } = await daemon();
    const r = await cli('plugins', 'higgsfield-mode', 'api');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/api/);
    expect(readFileSync(home.config, 'utf8')).toMatch(/mode: api/);
    const bad = await cli('plugins', 'higgsfield-mode', 'nope');
    expect(bad.code).toBe(1);
  });
});

describe('shibaox keys set HIGGSFIELD_API_KEY', () => {
  it('refuses a value without its colon with the daemon message and exit 1', async () => {
    const { cli } = await daemon();
    const r = await cli('keys', 'set', 'HIGGSFIELD_API_KEY', 'nocolon');
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/paste it as-is/);
  });
});

describe('shibaox doctor: higgsfield api', () => {
  const doctor = async (env: Record<string, string>) => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hfapi-'));
    tmp.push(home);
    scaffoldOrg(home);
    const r = await run({ SHIBAOX_HOME: home, PATH: '/usr/bin:/bin', ...env }, 'doctor');
    return r.stdout.split('\n').find((l) => /higgsfield api/.test(l)) ?? '';
  };
  it('a valid key, a refused key, no key', async () => {
    const base404 = await api(404);
    expect(
      await doctor({ HIGGSFIELD_API_KEY: 'id:secret', SHIBAOX_HIGGSFIELD_API_BASE: base404 }),
    ).toMatch(/key set, valid · mode auto → api/);
    const base401 = await api(401);
    const refused = await doctor({
      HIGGSFIELD_API_KEY: 'id:secret',
      SHIBAOX_HIGGSFIELD_API_BASE: base401,
    });
    expect(refused).toMatch(/key set, rejected \(401\)/);
    expect(refused).not.toContain('secret');
    expect(await doctor({ SHIBAOX_HIGGSFIELD_API_BASE: base404 })).toMatch(
      /no key \(optional: https:\/\/open\.higgsfield\.ai\/api-keys\)/,
    );
  });
  it("warns when the org's higgsfield skill predates the API mode", async () => {
    const home = mkdtempSync(join(tmpdir(), 'doctor-hfskill-'));
    tmp.push(home);
    scaffoldOrg(home);
    const base = await api(404);
    const env = { SHIBAOX_HOME: home, PATH: '/usr/bin:/bin', SHIBAOX_HIGGSFIELD_API_BASE: base };
    const fresh = await run(env, 'doctor');
    expect(fresh.stdout).not.toMatch(/skills add higgsfield --builtin --replace/);
    writeFileSync(join(home, 'org', 'skills', 'higgsfield', 'SKILL.md'), '# old skill\n');
    const old = await run(env, 'doctor');
    expect(old.stdout).toMatch(/shibaox skills add higgsfield --builtin --replace/);
  });
});
