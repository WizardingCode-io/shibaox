import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homePaths, LAUNCHD_LABEL, plistPath, unitPath } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonInstall, daemonUninstall, serviceLine } from '../src/commands/daemon.js';
import type { Out } from '../src/output.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fakeOut = () => {
  const lines: string[] = [];
  const objs: unknown[] = [];
  const out: Out = { line: (l) => lines.push(l), obj: (o) => objs.push(o) };
  return { out, lines, objs };
};
const fakeExec = (visible: string[] = []) => {
  const calls: string[][] = [];
  const exec = async ({ argv }: { argv: string[] }) => {
    calls.push(argv);
    // `zsh -lc 'printenv NAME'`: what a login shell would see
    if (argv[0] === '/bin/zsh') {
      const name = String(argv[2]).replace('printenv ', '');
      return visible.includes(name)
        ? { exitCode: 0, stdout: 'x\n', stderr: '', timedOut: false }
        : { exitCode: 1, stdout: '', stderr: '', timedOut: false };
    }
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { calls, exec };
};

describe('shibaox daemon install / uninstall', () => {
  it('writes the agent, loads it and says where; uninstall removes it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-svc-'));
    dirs.push(home);
    const env = { HOME: home, SHIBAOX_HOME: join(home, '.shibaox') };
    const paths = homePaths(env);
    const { calls, exec } = fakeExec();
    const o = fakeOut();
    // no daemon is running: nothing to stop first
    expect(
      await daemonInstall(o.out, { env, paths, exec, uid: 501, stopRunning: async () => false }),
    ).toBe(0);
    expect(existsSync(plistPath(env))).toBe(true);
    expect(o.lines.join('\n')).toContain('launchd');
    expect(o.lines.join('\n')).toContain(plistPath(env));
    expect(calls.some((c) => c[1] === 'bootstrap')).toBe(true);
    expect(await serviceLine({ env, exec, uid: 501 })).toBe('service: launchd (installed)');
    const u = fakeOut();
    expect(await daemonUninstall(u.out, { env, paths, exec, uid: 501 })).toBe(0);
    expect(existsSync(plistPath(env))).toBe(false);
    expect(u.lines.join('\n')).toContain('removed');
    expect(await serviceLine({ env, exec, uid: 501 })).toBe('service: not installed');
    expect(calls.some((c) => c[1] === 'bootout' && c[2] === `gui/501/${LAUNCHD_LABEL}`)).toBe(true);
  });
  it('stops a detached daemon before launchd takes over', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-svc-'));
    dirs.push(home);
    const env = { HOME: home, SHIBAOX_HOME: join(home, '.shibaox') };
    const { exec } = fakeExec();
    const o = fakeOut();
    let stopped = 0;
    await daemonInstall(o.out, {
      env,
      paths: homePaths(env),
      exec,
      uid: 501,
      stopRunning: async () => {
        stopped++;
        return true;
      },
    });
    expect(stopped).toBe(1);
    expect(o.lines.join('\n')).toContain('Stopped the running daemon');
  });
  it('warns about keys a login shell cannot see (exports living in ~/.zshrc)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-svc-'));
    dirs.push(home);
    const env = {
      HOME: home,
      SHIBAOX_HOME: join(home, '.shibaox'),
      ANTHROPIC_API_KEY: 'k',
      SHIBAOX_TELEGRAM_TOKEN: 't',
    };
    const { exec } = fakeExec(['SHIBAOX_TELEGRAM_TOKEN']);
    const o = fakeOut();
    await daemonInstall(o.out, {
      env,
      paths: homePaths(env),
      exec,
      uid: 501,
      stopRunning: async () => false,
    });
    const text = o.lines.join('\n');
    expect(text).toContain('ANTHROPIC_API_KEY');
    expect(text).toContain('~/.zprofile');
    expect(text).not.toContain('SHIBAOX_TELEGRAM_TOKEN');
  });
});

describe('shibaox daemon install on Linux', () => {
  it('writes a systemd user unit, enables it now and says how to keep it running unattended', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cli-svc-'));
    dirs.push(home);
    const env = { HOME: home, SHIBAOX_HOME: join(home, '.shibaox') };
    const paths = homePaths(env);
    const { calls, exec } = fakeExec();
    const o = fakeOut();
    expect(
      await daemonInstall(o.out, {
        env,
        paths,
        exec,
        platform: 'linux',
        stopRunning: async () => false,
      }),
    ).toBe(0);
    expect(existsSync(unitPath(env))).toBe(true);
    expect(o.lines.join('\n')).toContain('systemd');
    expect(o.lines.join('\n')).toContain('loginctl enable-linger');
    expect(o.lines.join('\n')).not.toContain('login shell'); // the zsh note is a macOS thing
    expect(calls.some((c) => c[0] === 'systemctl' && c[2] === 'enable')).toBe(true);
    expect(calls.some((c) => c[0] === '/bin/zsh')).toBe(false);
    expect(await serviceLine({ env, exec, platform: 'linux' })).toBe(
      'service: systemd (installed)',
    );
    const u = fakeOut();
    expect(await daemonUninstall(u.out, { env, paths, exec, platform: 'linux' })).toBe(0);
    expect(existsSync(unitPath(env))).toBe(false);
  });
  it('says so on a platform without a service manager', async () => {
    const o = fakeOut();
    expect(await daemonInstall(o.out, { platform: 'win32', stopRunning: async () => false })).toBe(
      1,
    );
    expect(o.lines.join('\n')).toContain('daemon start --detach');
  });
});
