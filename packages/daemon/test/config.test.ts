import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../src/config.js';
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
