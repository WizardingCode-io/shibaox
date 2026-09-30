import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installLine } from '../src/commands/doctor.js';
import { upgradeCommand } from '../src/commands/upgrade.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const out = () => {
  const lines: string[] = [];
  const objs: unknown[] = [];
  return {
    lines,
    objs,
    out: { line: (l: string) => lines.push(l), obj: (o: unknown) => objs.push(o) },
  };
};
type Exec = NonNullable<Parameters<typeof upgradeCommand>[0]['exec']>;
/** A fake git/pnpm: HEAD moves from `heads[0]` to `heads[1]` on pull; `fail` names a failing step. */
const fakeExec = (o: { heads?: [string, string]; fail?: string; detached?: boolean } = {}) => {
  const calls: { argv: string[]; cwd: string }[] = [];
  let head = o.heads?.[0] ?? 'aaaaaaa1';
  const exec: Exec = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    const cmd = argv.join(' ');
    const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
    const bad = (stderr: string) => ({ exitCode: 1, stdout: '', stderr, timedOut: false });
    if (cmd === 'git symbolic-ref -q HEAD') return o.detached ? bad('') : ok('refs/heads/main\n');
    if (cmd === 'git rev-parse HEAD') return ok(`${head}\n`);
    if (cmd === o.fail) return bad(`${cmd} broke`);
    if (cmd === 'git pull --ff-only') head = o.heads?.[1] ?? head;
    return ok();
  };
  return { calls, exec };
};
const appCheckout = () => {
  const home = mkdtempSync(join(tmpdir(), 'shx-up-'));
  dirs.push(home);
  const app = join(home, 'app');
  mkdirSync(app);
  execFileSync('git', ['init', '-q', app]);
  return { home, app, cli: join(app, 'apps/cli/dist/index.js') };
};

describe('shibaox upgrade', () => {
  it('pulls the app checkout, installs, builds and restarts the daemon', async () => {
    const { app, cli } = appCheckout();
    const { calls, exec } = fakeExec({ heads: ['aaaaaaa1', 'bbbbbbb2'] });
    const restarted: string[] = [];
    const o = out();
    const code = await upgradeCommand({
      app,
      cli,
      exec,
      restart: async () => {
        restarted.push('yes');
        return 'restarted';
      },
      out: o.out,
    });
    expect(code).toBe(0);
    const steps = calls
      .map((c) => c.argv.join(' '))
      .filter((c) => !c.startsWith('git rev-parse') && !c.startsWith('git symbolic-ref'));
    expect(steps).toEqual([
      'git pull --ff-only',
      'pnpm install --frozen-lockfile',
      'pnpm build --filter=!@wizardingcode/shibaox-desktop',
    ]);
    expect(calls.every((c) => c.cwd === app)).toBe(true);
    expect(restarted).toEqual(['yes']);
    expect(o.lines.join('\n')).toMatch(/Upgraded .*aaaaaaa → bbbbbbb.*restarted/);
  });
  it('an up-to-date checkout is left alone: no build, no daemon restart', async () => {
    const { app, cli } = appCheckout();
    const { calls, exec } = fakeExec({ heads: ['aaaaaaa1', 'aaaaaaa1'] });
    const restarted: string[] = [];
    const o = out();
    const code = await upgradeCommand({
      app,
      cli,
      exec,
      restart: async () => {
        restarted.push('yes');
        return '';
      },
      out: o.out,
    });
    expect(code).toBe(0);
    expect(calls.some((c) => c.argv[0] === 'pnpm')).toBe(false);
    expect(restarted).toEqual([]);
    expect(o.lines.join('\n')).toMatch(/Already up to date/);
  });
  it('a failed build says where the checkout is, that the daemon keeps the old build, and how to go back', async () => {
    const { app, cli } = appCheckout();
    const { exec } = fakeExec({
      heads: ['aaaaaaa1', 'bbbbbbb2'],
      fail: 'pnpm build --filter=!@wizardingcode/shibaox-desktop',
    });
    const restarted: string[] = [];
    const o = out();
    const code = await upgradeCommand({
      app,
      cli,
      exec,
      restart: async () => {
        restarted.push('yes');
        return '';
      },
      out: o.out,
    });
    expect(code).toBe(1);
    expect(restarted).toEqual([]);
    const text = o.lines.join('\n');
    expect(text).toContain('pnpm build --filter=!@wizardingcode/shibaox-desktop broke');
    expect(text).toMatch(/keeps the old build/);
    expect(text).toContain(`git -C ${app} reset --hard aaaaaaa`);
  });
  it('refuses a checkout at a tag, and a CLI that does not run from the checkout', async () => {
    const { app, cli, home } = appCheckout();
    const detached = out();
    expect(
      await upgradeCommand({
        app,
        cli,
        exec: fakeExec({ detached: true }).exec,
        restart: async () => '',
        out: detached.out,
      }),
    ).toBe(1);
    expect(detached.lines.join('\n')).toMatch(/tag|SHIBAOX_REF/);
    const elsewhere = out();
    const { calls, exec } = fakeExec();
    expect(
      await upgradeCommand({
        app,
        cli: join(home, 'dev/apps/cli/dist/index.js'),
        exec,
        restart: async () => '',
        out: elsewhere.out,
      }),
    ).toBe(1);
    expect(calls).toEqual([]);
    expect(elsewhere.lines.join('\n')).toMatch(/runs from/);
  });
  it('says so when shibaox was not installed by the installer (no app checkout)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shx-up-'));
    dirs.push(home);
    const { calls, exec } = fakeExec();
    const o = out();
    const code = await upgradeCommand({
      app: join(home, 'app'),
      exec,
      restart: async () => '',
      out: o.out,
    });
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(o.lines.join('\n')).toMatch(/install\.sh|git pull/);
  });
});

describe('doctor: the install', () => {
  it('tells an installer install (bin on the PATH or not) from a development checkout, by where the CLI runs from', () => {
    const home = mkdtempSync(join(tmpdir(), 'shx-doc-'));
    dirs.push(home);
    const app = join(home, 'app');
    const bin = join(home, 'bin');
    mkdirSync(join(app, 'apps', 'cli', 'dist'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'shibaox'), '#!/bin/sh\n');
    const cli = join(app, 'apps', 'cli', 'dist', 'index.js');
    writeFileSync(cli, ''); // exists: its real path (/private/var…) must still count as inside the app
    const onPath = installLine({ root: home, env: { PATH: `${bin}:/usr/bin` }, cli });
    expect(onPath).toMatchObject({ name: 'install', ok: true });
    expect(onPath.detail).toContain(app);
    const offPath = installLine({ root: home, env: { PATH: '/usr/bin' }, cli });
    expect(offPath.ok).toBe(false);
    expect(offPath.detail).toContain(bin);
    expect(offPath.detail).toMatch(/PATH/);
    // the CLI runs from somewhere else: a development checkout, not a fault
    const dev = installLine({
      root: home,
      env: { PATH: '/usr/bin' },
      cli: join(home, 'dev/apps/cli/dist/index.js'),
    });
    expect(dev).toMatchObject({ ok: true });
    expect(dev.detail).toMatch(/development checkout/);
    expect(dev.detail).toContain(join(home, 'dev'));
  });
});
