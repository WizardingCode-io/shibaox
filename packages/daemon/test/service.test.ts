import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../src/home.js';
import {
  installService,
  LAUNCHD_LABEL,
  plistPath,
  renderPlist,
  serviceStatus,
  uninstallService,
} from '../src/service.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = () => {
  const home = mkdtempSync(join(tmpdir(), 'svc-'));
  dirs.push(home);
  const env = { HOME: home, SHIBAOX_HOME: join(home, '.shibaox') };
  return { home, env, paths: homePaths(env) };
};
type Exec = Parameters<typeof installService>[0]['exec'];
const fakeExec = (fail: (argv: string[]) => boolean = () => false) => {
  const calls: string[][] = [];
  const exec: Exec = async ({ argv }) => {
    calls.push(argv);
    return fail(argv)
      ? { exitCode: 1, stdout: '', stderr: 'nope', timedOut: false }
      : { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { calls, exec };
};

describe('launchd service', () => {
  it('renders a plist that execs the CLI through a login shell, keeps it alive and logs to daemon.log', () => {
    const { paths } = setup();
    const xml = renderPlist({ node: '/usr/local/bin/node', cli: '/opt/shibaox/cli.js', paths });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain('<string>/bin/zsh</string>');
    expect(xml).toContain('<string>-lc</string>');
    expect(xml).toContain(
      "<string>exec '/usr/local/bin/node' '/opt/shibaox/cli.js' daemon start</string>",
    );
    expect(xml).toContain('<key>KeepAlive</key>');
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain(`<string>${paths.log}</string>`);
    expect(xml).toContain(`<string>${paths.root}</string>`);
    expect(xml).not.toMatch(/API_KEY|TOKEN/);
  });
  it('install writes the plist under ~/Library/LaunchAgents and bootstraps it; uninstall boots it out and removes it', async () => {
    const { env, paths } = setup();
    // launchd does not know the label yet: `print` fails
    const { calls, exec } = fakeExec((argv) => argv[1] === 'print');
    const r = await installService({
      paths,
      env,
      node: '/n',
      cli: '/c',
      exec,
      uid: 501,
      pollMs: 1,
    });
    const file = plistPath(env);
    expect(file).toBe(join(env.HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(r.plist).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain("exec '/n' '/c' daemon start");
    expect(calls.filter((c) => c[1] !== 'print')).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', file],
    ]);
    calls.splice(0);
    await uninstallService({ paths, env, exec, uid: 501 });
    expect(calls).toEqual([['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]]);
    expect(existsSync(file)).toBe(false);
  });
  it('falls back to launchctl load when bootstrap is refused, and fails when both are', async () => {
    const { env, paths } = setup();
    const a = fakeExec((argv) => argv[1] === 'bootstrap' || argv[1] === 'print');
    await installService({ paths, env, node: '/n', cli: '/c', exec: a.exec, uid: 501, pollMs: 1 });
    expect(a.calls.at(-1)).toEqual(['launchctl', 'load', '-w', plistPath(env)]);
    const b = fakeExec((argv) => ['bootstrap', 'load', 'print'].includes(String(argv[1])));
    await expect(
      installService({ paths, env, node: '/n', cli: '/c', exec: b.exec, uid: 501, pollMs: 1 }),
    ).rejects.toThrow(/launchctl/);
  });
  it('waits for a previous instance to be booted out and retries bootstrap', async () => {
    const { env, paths } = setup();
    let prints = 0;
    let bootstraps = 0;
    const calls: string[][] = [];
    const exec: Exec = async ({ argv }) => {
      calls.push(argv);
      // the label stays visible for two polls after bootout, and the first bootstrap is refused
      if (argv[1] === 'print')
        return { exitCode: ++prints <= 2 ? 0 : 1, stdout: '', stderr: '', timedOut: false };
      if (argv[1] === 'bootstrap')
        return {
          exitCode: ++bootstraps === 1 ? 5 : 0,
          stdout: '',
          stderr: 'Input/output error',
          timedOut: false,
        };
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    await installService({ paths, env, node: '/n', cli: '/c', exec, uid: 501, pollMs: 1 });
    expect(prints).toBe(3);
    expect(bootstraps).toBe(2);
    expect(calls.some((c) => c[1] === 'load')).toBe(false);
  });

  it('status reads launchctl print and the plist', async () => {
    const { env, paths } = setup();
    expect(await serviceStatus({ env, exec: fakeExec().exec, uid: 501 })).toBe('not-installed');
    await installService({
      paths,
      env,
      node: '/n',
      cli: '/c',
      exec: fakeExec((argv) => argv[1] === 'print').exec,
      uid: 501,
      pollMs: 1,
    });
    expect(await serviceStatus({ env, exec: fakeExec().exec, uid: 501 })).toBe('installed');
    const off = fakeExec((argv) => argv[1] === 'print');
    expect(await serviceStatus({ env, exec: off.exec, uid: 501 })).toBe('not-loaded');
  });
});
