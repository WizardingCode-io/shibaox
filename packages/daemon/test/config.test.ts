import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HIGGSFIELD_MODES, loadDaemonConfig, writeDaemonConfig } from '../src/config.js';
import { homePaths } from '../src/home.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('daemon config and home', () => {
  it('a missing file yields the defaults', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    expect(loadDaemonConfig(join(dir, 'daemon.yaml'))).toMatchObject({
      max_concurrent_runs: 4,
      approval_timeout_minutes: 120,
      projects: [],
      channels: { macos: { enabled: true }, github: { enabled: true } },
    });
  });

  it('telegram gets the default token env and macos can be disabled', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(
      p,
      'max_concurrent_runs: 2\nchannels:\n  macos: { enabled: false }\n  telegram: { chat_id: 5 }\n',
    );
    expect(loadDaemonConfig(p)).toMatchObject({
      max_concurrent_runs: 2,
      approval_timeout_minutes: 120,
      projects: [],
      channels: {
        macos: { enabled: false },
        github: { enabled: true },
        telegram: { bot_token_env: 'SHIBAOX_TELEGRAM_TOKEN', chat_id: 5, workflow: 'chat' },
      },
    });
  });

  it('an invalid value names the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, 'max_concurrent_runs: 0\n');
    expect(() => loadDaemonConfig(p)).toThrow(p);
  });

  it('homePaths honours SHIBAOX_HOME and creates the directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const home = join(dir, 'home');
    const paths = homePaths({ SHIBAOX_HOME: home });
    expect(paths).toEqual({
      root: home,
      socket: join(home, 'daemon.sock'),
      pid: join(home, 'daemon.pid'),
      log: join(home, 'daemon.log'),
      config: join(home, 'daemon.yaml'),
      db: join(home, 'events.db'),
      secrets: join(home, 'secrets.json'),
      org: join(home, 'org'),
      launcher: join(home, 'daemon.sh'),
    });
    expect(homePaths({ HOME: dir }).root).toBe(join(dir, '.shibaox'));
  });
});

describe('paths in daemon.yaml', () => {
  it('relative org and project resolve against the file, not the daemon cwd', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, 'channels:\n  telegram: { chat_id: 5, org: ./org, project: ../proj }\n');
    const c = loadDaemonConfig(p);
    expect(c.channels.telegram?.org).toBe(join(dir, 'org'));
    expect(c.channels.telegram?.project).toBe(resolve(dir, '..', 'proj'));
  });

  it('projects_dir resolves against the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, 'projects_dir: ./repos\n');
    expect(loadDaemonConfig(p).projects_dir).toBe(join(dir, 'repos'));
  });

  it('listen gets its defaults; projects and TLS files resolve against the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, 'listen: {}\nprojects: [./a, /abs/b]\n');
    const c = loadDaemonConfig(p);
    expect(c.listen).toEqual({ host: '127.0.0.1', port: 7433, token_env: 'SHIBAOX_DAEMON_TOKEN' });
    expect(c.projects).toEqual([join(dir, 'a'), '/abs/b']);
    writeFileSync(
      p,
      'listen: { host: 0.0.0.0, port: 8443, token_env: MY_TOKEN, tls: { cert: ./c.pem, key: ./k.pem } }\n',
    );
    expect(loadDaemonConfig(p).listen).toEqual({
      host: '0.0.0.0',
      port: 8443,
      token_env: 'MY_TOKEN',
      tls: { cert: join(dir, 'c.pem'), key: join(dir, 'k.pem') },
    });
  });
});

describe('partners.higgsfield.mode and the daemon.yaml writer', () => {
  it('a missing file means auto; a bogus mode is refused', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    expect(loadDaemonConfig(p).partners.higgsfield.mode).toBe('auto');
    writeFileSync(p, 'partners: {}\n');
    expect(loadDaemonConfig(p).partners.higgsfield.mode).toBe('auto');
    writeFileSync(p, 'partners:\n  higgsfield: { signup_url: "https://x.y" }\n');
    expect(loadDaemonConfig(p).partners.higgsfield.mode).toBe('auto');
    writeFileSync(p, 'partners:\n  higgsfield: { mode: bogus }\n');
    expect(() => loadDaemonConfig(p)).toThrow(/mode/);
  });

  it('writes the mode keeping comments and the listen block; creates a missing file', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, '# my daemon\nlisten: { port: 8443 } # remote\nmax_concurrent_runs: 3\n');
    const c = writeDaemonConfig(p, { higgsfieldMode: 'api' });
    expect(c.partners.higgsfield.mode).toBe('api');
    expect(c.listen?.port).toBe(8443);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# my daemon');
    expect(text).toContain('# remote');
    expect(loadDaemonConfig(p)).toMatchObject({
      max_concurrent_runs: 3,
      partners: { higgsfield: { mode: 'api' } },
    });
    const fresh = join(dir, 'sub', 'daemon.yaml');
    expect(writeDaemonConfig(fresh, { higgsfieldMode: 'account' }).partners.higgsfield.mode).toBe(
      'account',
    );
    expect(existsSync(fresh)).toBe(true);
  });

  it('refuses an invalid mode without touching the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, '# keep\nmax_concurrent_runs: 3\n');
    expect(() => writeDaemonConfig(p, { higgsfieldMode: 'x' as never })).toThrow(/mode/);
    expect(readFileSync(p, 'utf8')).toBe('# keep\nmax_concurrent_runs: 3\n');
    expect(HIGGSFIELD_MODES).toEqual(['auto', 'account', 'api']);
  });

  it('keeps the file mode, and a symlinked daemon.yaml stays a symlink to its updated target', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, 'max_concurrent_runs: 3\n');
    chmodSync(p, 0o600);
    writeDaemonConfig(p, { higgsfieldMode: 'api' });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const target = join(dir, 'real.yaml');
    writeFileSync(target, 'max_concurrent_runs: 2\n');
    chmodSync(target, 0o640);
    const link = join(dir, 'linked.yaml');
    symlinkSync(target, link);
    writeDaemonConfig(link, { higgsfieldMode: 'account' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toMatch(/mode: account/);
    expect(statSync(target).mode & 0o777).toBe(0o640);
  });

  it('a daemon.yaml with a YAML syntax error is refused with its line, untouched', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    const broken = '# keep\nmax_concurrent_runs: 3\nchannels: [unclosed\n';
    writeFileSync(p, broken);
    expect(() => writeDaemonConfig(p, { higgsfieldMode: 'api' })).toThrow(
      /daemon\.yaml has a syntax error at line \d+: fix it first/,
    );
    expect(readFileSync(p, 'utf8')).toBe(broken);
  });
});

describe('writeDaemonConfig: telegram pairing', () => {
  it('sets channels.telegram.chat_id, keeps comments and other keys, keeps the default token env', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(
      p,
      '# mine\nmax_concurrent_runs: 3 # three\nchannels:\n  macos: { enabled: false }\n  telegram:\n    chat_id: 5 # old\n    org: ./org\n',
    );
    const c = writeDaemonConfig(p, { telegram: { chat_id: 42 } });
    expect(c.channels.telegram).toMatchObject({
      chat_id: 42,
      bot_token_env: 'SHIBAOX_TELEGRAM_TOKEN',
      org: join(dir, 'org'),
    });
    const text = readFileSync(p, 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('# three');
    expect(text).toContain('chat_id: 42');
    expect(text).not.toContain('bot_token_env');
    expect(c.channels.macos.enabled).toBe(false);
    expect(c.max_concurrent_runs).toBe(3);
  });

  it('creates the file when absent and writes bot_token_env when given', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'sub', 'daemon.yaml');
    const c = writeDaemonConfig(p, { telegram: { chat_id: -100123, bot_token_env: 'MY_BOT' } });
    expect(c.channels.telegram).toMatchObject({ chat_id: -100123, bot_token_env: 'MY_BOT' });
    expect(readFileSync(p, 'utf8')).toMatch(/bot_token_env: MY_BOT/);
  });

  it('a chat id that is not an integer is refused before anything is written', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(p, '# keep\n');
    expect(() => writeDaemonConfig(p, { telegram: { chat_id: 1.5 } })).toThrow(/chat_id/);
    expect(readFileSync(p, 'utf8')).toBe('# keep\n');
  });
});
