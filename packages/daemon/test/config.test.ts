import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDaemonConfig } from '../src/config.js';
import { homePaths } from '../src/home.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('daemon config and home', () => {
  it('a missing file yields the defaults', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    expect(loadDaemonConfig(join(dir, 'daemon.yaml'))).toEqual({
      max_concurrent_runs: 4,
      approval_timeout_minutes: 120,
      channels: { macos: { enabled: true } },
    });
  });

  it('telegram gets the default token env and macos can be disabled', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-home-'));
    const p = join(dir, 'daemon.yaml');
    writeFileSync(
      p,
      'max_concurrent_runs: 2\nchannels:\n  macos: { enabled: false }\n  telegram: { chat_id: 5 }\n',
    );
    expect(loadDaemonConfig(p)).toEqual({
      max_concurrent_runs: 2,
      approval_timeout_minutes: 120,
      channels: {
        macos: { enabled: false },
        telegram: { bot_token_env: 'SHIBAOX_TELEGRAM_TOKEN', chat_id: 5 },
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
    });
    expect(homePaths({ HOME: dir }).root).toBe(join(dir, '.shibaox'));
  });
});
