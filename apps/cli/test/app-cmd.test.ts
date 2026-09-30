import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from '@wizardingcode/shibaox-bridge';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, homePaths } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function daemonAt(extra: ConstructorParameters<typeof Daemon>[0] = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-app-'));
  tmpDirs.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  cpSync(sample, join(dir, 'proj'), { recursive: true });
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Shibaox</title>');
  writeFileSync(join(dist, 'assets', 'a.js'), '1');
  const daemon = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: {},
    log: () => {},
    version: '0.2.2',
    appDist: dist,
    ...extra,
  });
  daemons.push(daemon);
  await daemon.start();
  return { dir, home, daemon, dist };
}

const cli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { PATH: process.env.PATH ?? '', SHIBAOX_NO_AUTOSTART: '1', ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

describe('the app bridge', () => {
  it('serves the app, forwards the API to the socket behind its own token, and streams events', async () => {
    const { home, dist } = await daemonAt();
    const bridge = await startBridge({
      socketPath: home.socket,
      dist,
      token: 'bridge-tok',
      port: 0,
    });
    closers.push(() => bridge.close());
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/#token=bridge-tok$/);
    const base = bridge.url.split('/app/')[0] as string;
    expect((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location')).toBe('/app/');
    expect(await (await fetch(`${base}/app/`)).text()).toContain('<title>Shibaox');
    expect((await fetch(`${base}/app/assets/a.js`)).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    const h = await fetch(`${base}/health`, { headers: { authorization: 'Bearer bridge-tok' } });
    expect(h.status).toBe(200);
    expect((await h.json()) as { version: string }).toMatchObject({ version: '0.2.2' });
    const runs = await fetch(`${base}/runs`, { headers: { authorization: 'Bearer bridge-tok' } });
    expect(await runs.json()).toEqual([]);
    const missing = await fetch(`${base}/runs/nope`, {
      headers: { authorization: 'Bearer bridge-tok' },
    });
    expect(missing.status).toBe(404);
    const sse = await fetch(`${base}/runs/nope/events`, {
      headers: { authorization: 'Bearer bridge-tok' },
    });
    expect(sse.status).toBe(404);
    // a POST body reaches the daemon (a bad request is the daemon's own answer, not the bridge's)
    const post = await fetch(`${base}/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer bridge-tok', 'content-type': 'application/json' },
      body: JSON.stringify({ workflow: 'chat' }),
    });
    expect(post.status).toBe(400);
    // HEAD on the app is public too
    expect((await fetch(`${base}/app/`, { method: 'HEAD' })).status).toBe(200);
  });
  it('a bad --port is refused with a clear message', async () => {
    const { dir, home } = await daemonAt();
    const r = await cli({ SHIBAOX_HOME: home.root, HOME: dir }, 'app', '--no-open', '--port', 'x');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/port/);
  });
});

describe('shibaox app', () => {
  it('with a network listener, prints the address of the app with the vault token and exits', async () => {
    const { dir, home, daemon } = await daemonAt({
      env: { SHIBAOX_DAEMON_TOKEN: 'tok-1' },
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      },
    });
    const port = daemon.listenAddress()?.port;
    const r = await cli(
      { SHIBAOX_HOME: home.root, HOME: dir, SHIBAOX_DAEMON_TOKEN: 'tok-1' },
      'app',
      '--no-open',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`http://127.0.0.1:${port}/app/#token=tok-1`);
    const none = await cli({ SHIBAOX_HOME: home.root, HOME: dir }, 'app', '--no-open');
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain('SHIBAOX_DAEMON_TOKEN');
  });
  it("with a remote daemon configured, prints that daemon's app address", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-app-remote-'));
    tmpDirs.push(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const r = await cli(
      {
        SHIBAOX_HOME: home.root,
        HOME: dir,
        SHIBAOX_REMOTE: 'https://vps.example:7433',
        SHIBAOX_REMOTE_TOKEN: 'rt',
      },
      'app',
      '--no-open',
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('https://vps.example:7433/app/#token=rt');
  });
});
