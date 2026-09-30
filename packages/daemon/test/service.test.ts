import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homePaths } from '../src/home.js';
import {
  installService,
  LAUNCHD_LABEL,
  plistPath,
  renderPlist,
  renderUnit,
  SYSTEMD_UNIT,
  serviceKind,
  servicePaths,
  servicePredatesLauncher,
  serviceStatus,
  uninstallService,
  unitPath,
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
    const xml = renderPlist({ launcher: join(paths.root, 'daemon.sh'), paths });
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain('<string>/bin/zsh</string>');
    expect(xml).toContain('<string>-lc</string>');
    // the plist runs a launcher that resolves node and the CLI at launch: a Node upgrade
    // that moves both (nvm, brew) never strands the service
    expect(xml).toContain(`<string>exec '${join(paths.root, 'daemon.sh')}'</string>`);
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
      platform: 'darwin',
      pollMs: 1,
    });
    const file = plistPath(env);
    expect(file).toBe(join(env.HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(r.plist).toBe(file);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain(`exec '${paths.launcher}'`);
    const launcher = readFileSync(paths.launcher, 'utf8');
    expect(launcher).toContain("node='/n'");
    expect(launcher).toContain("cli='/c'");
    expect(launcher).toContain('command -v node'); // the login shell's node when the recorded one is gone
    expect(launcher).toContain(`modules='${process.versions.modules}'`); // only a node of the same ABI may stand in
    expect(launcher).toContain('process.versions.modules');
    expect(launcher).toContain('run shibaox daemon install'); // else: say why in daemon.log and throttle the respawns
    expect(launcher).toContain('sleep 60');
    expect(launcher).toContain('command -v shibaox'); // an installed CLI when the recorded one is gone
    expect(launcher).toContain('daemon start');
    // recorded paths that no longer exist: the service is stale until reinstalled
    expect(servicePaths(paths)).toEqual({ node: '/n', cli: '/c', stale: true });
    expect(calls.filter((c) => c[1] !== 'print')).toEqual([
      ['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', file],
    ]);
    calls.splice(0);
    await uninstallService({ paths, env, exec, uid: 501, platform: 'darwin' });
    expect(calls).toEqual([['launchctl', 'bootout', `gui/501/${LAUNCHD_LABEL}`]]);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(paths.launcher)).toBe(false);
    expect(servicePaths(paths)).toBeUndefined();
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
    expect(await serviceStatus({ env, exec: fakeExec().exec, uid: 501, platform: 'darwin' })).toBe(
      'not-installed',
    );
    await installService({
      paths,
      env,
      node: '/n',
      cli: '/c',
      exec: fakeExec((argv) => argv[1] === 'print').exec,
      uid: 501,
      platform: 'darwin',
      pollMs: 1,
    });
    expect(await serviceStatus({ env, exec: fakeExec().exec, uid: 501, platform: 'darwin' })).toBe(
      'installed',
    );
    const off = fakeExec((argv) => argv[1] === 'print');
    expect(await serviceStatus({ env, exec: off.exec, uid: 501, platform: 'darwin' })).toBe(
      'not-loaded',
    );
  });
});

describe('a plist from before the launcher', () => {
  it('is reported so the user reinstalls once', () => {
    const { env, paths } = setup();
    const file = plistPath(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "<plist><string>exec '/n' '/c' daemon start</string></plist>");
    expect(servicePredatesLauncher(paths, env)).toBe(true);
    writeFileSync(file, renderPlist({ launcher: paths.launcher, paths }));
    expect(servicePredatesLauncher(paths, env)).toBe(false);
  });
});

describe('systemd user service (Linux)', () => {
  it('renders a unit that runs the launcher, restarts it and logs to daemon.log', () => {
    const { paths } = setup();
    const unit = renderUnit({ launcher: paths.launcher, paths, path: '/opt/node/bin:/usr/bin' });
    expect(unit).toContain('[Unit]');
    expect(unit).toContain(`ExecStart="${paths.launcher}"`);
    // the user's PATH at install time: a unit has no login shell, so nvm's node and the
    // tools next to it (claude, bun) would be invisible otherwise
    expect(unit).toContain('Environment=PATH=/opt/node/bin:/usr/bin');
    expect(unit).not.toContain('network-online');
    const odd = renderUnit({ launcher: '/home/me/my app/100%/daemon.sh', paths, path: '/usr/bin' });
    expect(odd).toContain('ExecStart="/home/me/my app/100%%/daemon.sh"');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain(`WorkingDirectory=${paths.root}`);
    expect(unit).toContain(`StandardOutput=append:${paths.log}`);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/API_KEY|TOKEN/);
  });
  it('install writes ~/.config/systemd/user/shibaox.service and enables it now; uninstall disables and removes it', async () => {
    const { env, paths } = setup();
    const { calls, exec } = fakeExec();
    const r = await installService({
      paths,
      env: { ...env, PATH: '/usr/bin' },
      node: '/opt/node/bin/node',
      cli: '/c',
      exec,
      platform: 'linux',
    });
    expect(r.plist).toBe(unitPath(env));
    expect(readFileSync(r.plist, 'utf8')).toContain('Environment=PATH=/opt/node/bin:/usr/bin');
    expect(r.plist).toBe(join(env.HOME, '.config', 'systemd', 'user', SYSTEMD_UNIT));
    expect(existsSync(r.plist)).toBe(true);
    expect(existsSync(paths.launcher)).toBe(true);
    expect(readFileSync(paths.launcher, 'utf8')).toContain("cli='/c'");
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', SYSTEMD_UNIT],
    ]);
    const off = fakeExec();
    await uninstallService({ paths, env, exec: off.exec, platform: 'linux' });
    expect(off.calls).toEqual([
      ['systemctl', '--user', 'disable', '--now', SYSTEMD_UNIT],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    expect(existsSync(r.plist)).toBe(false);
    expect(existsSync(paths.launcher)).toBe(false);
  });
  it('status asks systemctl whether the unit is active; a refused enable is an error', async () => {
    const { env, paths } = setup();
    expect(await serviceStatus({ env, exec: fakeExec().exec, platform: 'linux' })).toBe(
      'not-installed',
    );
    await installService({
      paths,
      env,
      node: '/n',
      cli: '/c',
      exec: fakeExec().exec,
      platform: 'linux',
    });
    expect(await serviceStatus({ env, exec: fakeExec().exec, platform: 'linux' })).toBe(
      'installed',
    );
    const inactive = fakeExec((argv) => argv[2] === 'is-active');
    expect(await serviceStatus({ env, exec: inactive.exec, platform: 'linux' })).toBe('not-loaded');
    const refused = fakeExec((argv) => argv[2] === 'enable');
    await expect(
      installService({ paths, env, node: '/n', cli: '/c', exec: refused.exec, platform: 'linux' }),
    ).rejects.toThrow(/systemctl/);
  });
  it('names the service manager of a platform, and refuses the ones it has none for', async () => {
    expect(serviceKind('darwin')).toBe('launchd');
    expect(serviceKind('linux')).toBe('systemd');
    expect(serviceKind('win32')).toBeUndefined();
    const { env, paths } = setup();
    await expect(
      installService({
        paths,
        env,
        node: '/n',
        cli: '/c',
        exec: fakeExec().exec,
        platform: 'win32',
      }),
    ).rejects.toThrow(/no service manager/);
  });
});
