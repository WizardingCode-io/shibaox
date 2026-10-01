import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, DaemonClient, homePaths } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function cliIn(env: Record<string, string>) {
  return (...args: string[]) =>
    new Promise<Result>((resolve) => {
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
}

async function remoteDaemon() {
  const dir = mkdtempSync(join(tmpdir(), 'cli-remote-'));
  tmpDirs.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'server-home') });
  const daemon = new Daemon({
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: { SHIBAOX_DAEMON_TOKEN: 'tok' },
    log: () => {},
    version: '0.2.8',
    discovery: false,
    config: {
      max_concurrent_runs: 2,
      approval_timeout_minutes: 1,
      channels: { macos: { enabled: false } },
      projects: ['/srv/app'],
      listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
    },
  });
  daemons.push(daemon);
  await daemon.start();
  const addr = daemon.listenAddress();
  if (!addr) throw new Error('no listener');
  const clientHome = join(dir, 'client-home');
  return { dir, baseUrl: `http://127.0.0.1:${addr.port}`, clientHome };
}

describe('shibaox remote', () => {
  it('set / show / clear keep ~/.shibaox/remote.json, owner-only; commands then reach the remote', async () => {
    const { baseUrl, clientHome, dir } = await remoteDaemon();
    const cli = cliIn({ SHIBAOX_HOME: clientHome, HOME: dir });
    const set = await cli('remote', 'set', baseUrl, 'tok');
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toContain(`Commands now go to ${baseUrl}`);
    expect(set.stdout).toContain('shell access'); // the plain warning about what a token is
    expect(statSync(join(clientHome, 'remote.json')).mode & 0o777).toBe(0o600);
    const show = await cli('remote', 'show', '--json');
    expect(JSON.parse(show.stdout.trim())).toEqual({
      baseUrl,
      token: 'tok…',
      source: 'file',
    });
    const status = await cli('daemon', 'status');
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain('version 0.2.8');
    expect(status.stdout).toContain(`remote: ${baseUrl}`);
    expect(status.stdout).not.toContain('socket:');
    const runs = await cli('runs', '--json');
    expect(runs.code, runs.stderr).toBe(0);
    const cleared = await cli('remote', 'clear');
    expect(cleared.code).toBe(0);
    expect(cleared.stdout).toContain('local daemon');
    const none = await cli('remote', 'show');
    expect(none.stdout).toContain('No remote');
    const local = await cli('runs', '--json');
    expect(local.code).toBe(1); // no local daemon, and never started from here
    expect(local.stderr).toContain('No shibaox daemon is running');
  });

  it('a wrong token is a clear error; SHIBAOX_REMOTE in the environment needs no file', async () => {
    const { baseUrl, clientHome, dir } = await remoteDaemon();
    const bad = await cliIn({
      SHIBAOX_HOME: clientHome,
      HOME: dir,
      SHIBAOX_REMOTE: baseUrl,
      SHIBAOX_REMOTE_TOKEN: 'nope',
    })('runs');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('refused the token');
    const good = await cliIn({
      SHIBAOX_HOME: clientHome,
      HOME: dir,
      SHIBAOX_REMOTE: baseUrl,
      SHIBAOX_REMOTE_TOKEN: 'tok',
    })('doctor');
    expect(good.stdout).toMatch(new RegExp(`daemon.*remote ${baseUrl}.*version 0\\.2\\.8`));
    expect(good.stdout).not.toContain('restart it'); // no restart nag about a daemon we cannot restart
    const noToken = await cliIn({ SHIBAOX_HOME: clientHome, HOME: dir, SHIBAOX_REMOTE: baseUrl })(
      'doctor',
    );
    expect(noToken.stdout).toMatch(/FAIL|warn.*daemon.*no token/);
  });

  it('remote set refuses a URL that is not http(s), and warns when the token travels in clear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-remote-'));
    tmpDirs.push(dir);
    const cli = cliIn({ SHIBAOX_HOME: join(dir, 'h'), HOME: dir });
    const bad = await cli('remote', 'set', 'box:7433', 'tok');
    expect(bad.code).toBe(1);
    expect(bad.stdout + bad.stderr).toMatch(/http/);
    const clear = await cli('remote', 'set', 'http://10.0.0.5:7433', 'tok');
    expect(clear.code).toBe(0);
    expect(clear.stdout).toContain('in clear');
  });
});

describe('shibaox serve', () => {
  it('listens on the given host and port with the token from the environment, and says so', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-serve-'));
    tmpDirs.push(dir);
    const child = spawn(process.execPath, [bin, 'serve', '--host', '127.0.0.1', '--port', '0'], {
      env: {
        PATH: process.env.PATH ?? '',
        SHIBAOX_HOME: join(dir, 'home'),
        HOME: dir,
        SHIBAOX_DAEMON_TOKEN: 'serve-tok',
      },
    });
    children.push(child);
    let out = '';
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString();
        const m = out.match(/serving on (http:\/\/127\.0\.0\.1:\d+)/);
        if (m?.[1]) resolve(m[1]);
      });
      child.stderr.on('data', (c: Buffer) => {
        out += c.toString();
      });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`no banner: ${out}`)), 30_000);
    });
    expect(out).toContain('shell access');
    const h = await new DaemonClient({ baseUrl: url, token: 'serve-tok' }).health();
    expect(h.runs).toBeDefined();
    await expect(new DaemonClient({ baseUrl: url, token: 'x' }).health()).rejects.toMatchObject({
      status: 401,
    });
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((r) => child.on('exit', r));
    expect(code).toBe(0);
  }, 40_000);

  it('refuses to serve while a daemon owns the socket (keys set started one), and says what to do', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-serve-'));
    tmpDirs.push(dir);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const running = new Daemon({
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '0.2.8',
      discovery: false,
    });
    daemons.push(running);
    await running.start();
    const r = await cliIn({ SHIBAOX_HOME: home.root, HOME: dir, SHIBAOX_DAEMON_TOKEN: 'tok' })(
      'serve',
      '--port',
      '0',
    );
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('already running');
    expect(r.stdout + r.stderr).toContain('shibaox daemon stop');
    expect(r.stdout + r.stderr).toContain('daemon.yaml');
  });

  it('refuses to serve without a token and says how to create one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-serve-'));
    tmpDirs.push(dir);
    const r = await cliIn({ SHIBAOX_HOME: join(dir, 'home'), HOME: dir })('serve', '--port', '0');
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain('SHIBAOX_DAEMON_TOKEN');
    expect(r.stdout + r.stderr).toContain('shibaox keys set SHIBAOX_DAEMON_TOKEN');
  });
});
