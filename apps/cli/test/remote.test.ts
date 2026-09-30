import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, homePaths } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';
import { connect } from '../src/client.js';
import {
  clearRemote,
  insecureNote,
  remoteFile,
  remoteTarget,
  saveRemote,
  validateRemoteUrl,
} from '../src/remote.js';

const tmpDirs: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cli-remote-'));
  tmpDirs.push(d);
  return d;
};

describe('the remote daemon setting', () => {
  it('nothing set means the local socket; remote.json names a remote; SHIBAOX_REMOTE wins over it', () => {
    const root = tmp();
    expect(remoteTarget({}, root)).toBeUndefined();
    saveRemote(root, { baseUrl: 'https://box.example:7433', token: 'file-token' });
    expect(remoteTarget({}, root)).toEqual({
      baseUrl: 'https://box.example:7433',
      token: 'file-token',
      source: 'file',
    });
    expect(remoteTarget({ SHIBAOX_REMOTE: 'http://10.0.0.5:7433' }, root)).toEqual({
      baseUrl: 'http://10.0.0.5:7433',
      token: undefined, // the saved token belongs to another daemon
      source: 'env',
    });
    expect(
      remoteTarget({ SHIBAOX_REMOTE: 'http://10.0.0.5:7433', SHIBAOX_REMOTE_TOKEN: 't2' }, root),
    ).toEqual({ baseUrl: 'http://10.0.0.5:7433', token: 't2', source: 'env' });
    // an empty SHIBAOX_REMOTE is "no remote" even with a file (a way to force local in a script)
    expect(remoteTarget({ SHIBAOX_REMOTE: '' }, root)?.source).toBe('file');
  });

  it('remote.json is readable by its owner only, and clear removes it', () => {
    const root = tmp();
    const file = saveRemote(root, { baseUrl: 'http://127.0.0.1:7433', token: 'secret' });
    expect(file).toBe(remoteFile(root));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      baseUrl: 'http://127.0.0.1:7433',
      token: 'secret',
    });
    expect(clearRemote(root)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(clearRemote(root)).toBe(false);
  });

  it('the saved token is reused only for the URL it was saved for; the env URL is validated', () => {
    const root = tmp();
    saveRemote(root, { baseUrl: 'https://vps:7433', token: 'T' });
    expect(remoteTarget({ SHIBAOX_REMOTE: 'http://10.0.0.9:7433' }, root)?.token).toBeUndefined();
    expect(remoteTarget({ SHIBAOX_REMOTE: 'https://vps:7433/' }, root)?.token).toBe('T');
    expect(() => remoteTarget({ SHIBAOX_REMOTE: 'box:7433' }, root)).toThrow(/http/);
  });

  it('remote set puts an existing remote.json back to 0600; a malformed file is refused, not ignored', () => {
    const root = tmp();
    const file = saveRemote(root, { baseUrl: 'http://127.0.0.1:7433', token: 'a' });
    chmodSync(file, 0o644);
    saveRemote(root, { baseUrl: 'http://127.0.0.1:7433', token: 'b' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, '{not json');
    expect(() => remoteTarget({}, root)).toThrow(/remote clear/);
  });

  it('accepts http(s) URLs only, normalised; warns about a token in clear to another host', () => {
    expect(validateRemoteUrl('http://box:7433/')).toBe('http://box:7433');
    expect(validateRemoteUrl('https://box.example/shibaox/')).toBe('https://box.example/shibaox');
    expect(() => validateRemoteUrl('box:7433')).toThrow(/http/);
    expect(() => validateRemoteUrl('ftp://box')).toThrow(/http/);
    expect(() => validateRemoteUrl('http://box:7433/?x=1')).toThrow(/query/);
    expect(insecureNote('http://127.0.0.1:7433')).toBeUndefined();
    expect(insecureNote('http://localhost:7433')).toBeUndefined();
    expect(insecureNote('https://box.example')).toBeUndefined();
    expect(insecureNote('http://10.0.0.5:7433')).toMatch(/in clear/);
  });
});

describe('connect() with a remote daemon', () => {
  async function remoteDaemon() {
    const dir = tmp();
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: { SHIBAOX_DAEMON_TOKEN: 'tok' },
      log: () => {},
      version: '0.1.9',
      discovery: false,
      config: {
        max_concurrent_runs: 2,
        approval_timeout_minutes: 1,
        channels: { macos: { enabled: false } },
        projects: [],
        listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
      },
    });
    daemons.push(daemon);
    await daemon.start();
    const addr = daemon.listenAddress();
    if (!addr) throw new Error('no listener');
    return { dir, baseUrl: `http://127.0.0.1:${addr.port}` };
  }

  it('talks to the remote and never touches a local socket', async () => {
    const { dir, baseUrl } = await remoteDaemon();
    const clientHome = join(dir, 'client-home');
    const lines: string[] = [];
    const client = await connect({
      env: { SHIBAOX_HOME: clientHome, SHIBAOX_REMOTE: baseUrl, SHIBAOX_REMOTE_TOKEN: 'tok' },
      log: (l) => lines.push(l),
      write: true,
    });
    expect(client.isRemote).toBe(true);
    expect((await client.health()).version).toBe('0.1.9');
    expect(existsSync(join(clientHome, 'daemon.sock'))).toBe(false);
    expect(lines).toEqual([]);
  });

  it('explains a refused token, a missing token and a remote that does not answer', async () => {
    const { dir, baseUrl } = await remoteDaemon();
    const env = { SHIBAOX_HOME: join(dir, 'client-home') };
    await expect(
      connect({ env: { ...env, SHIBAOX_REMOTE: baseUrl, SHIBAOX_REMOTE_TOKEN: 'nope' } }),
    ).rejects.toThrow(/refused the token.*shibaox remote set/s);
    await expect(connect({ env: { ...env, SHIBAOX_REMOTE: baseUrl } })).rejects.toThrow(
      /no token.*shibaox remote set/s,
    );
    await expect(
      connect({ env: { ...env, SHIBAOX_REMOTE: 'http://127.0.0.1:1', SHIBAOX_REMOTE_TOKEN: 'x' } }),
    ).rejects.toThrow(/No shibaox daemon answers at http:\/\/127\.0\.0\.1:1/);
  });
});
