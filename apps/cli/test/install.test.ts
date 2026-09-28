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
  return { lines, out: { line: (l: string) => lines.push(l), obj: () => {} } };
};
type Exec = NonNullable<Parameters<typeof upgradeCommand>[1]['exec']>;
const fakeExec = () => {
  const calls: { argv: string[]; cwd: string }[] = [];
  const exec: Exec = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { calls, exec };
};

describe('shibaox upgrade', () => {
  it('pulls the app checkout, installs, builds and restarts the daemon', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shx-up-'));
    dirs.push(home);
    const app = join(home, 'app');
    mkdirSync(app);
    execFileSync('git', ['init', '-q', app]);
    const { calls, exec } = fakeExec();
    const restarted: string[] = [];
    const o = out();
    const code = await upgradeCommand(
      {},
      { app, exec, restart: async () => restarted.push('yes'), out: o.out },
    );
    expect(code).toBe(0);
    expect(calls.map((c) => c.argv.join(' '))).toEqual([
      'git pull --ff-only',
      'pnpm install --frozen-lockfile',
      'pnpm build',
    ]);
    expect(calls.every((c) => c.cwd === app)).toBe(true);
    expect(restarted).toEqual(['yes']);
    expect(o.lines.join('\n')).toMatch(/up to date|upgraded/i);
  });
  it('says so when shibaox was not installed by the installer (no app checkout)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'shx-up-'));
    dirs.push(home);
    const { calls, exec } = fakeExec();
    const o = out();
    const code = await upgradeCommand(
      {},
      { app: join(home, 'app'), exec, restart: async () => {}, out: o.out },
    );
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(o.lines.join('\n')).toMatch(/install\.sh|git pull/);
  });
});

describe('doctor: the install', () => {
  it('reports the app checkout and whether the bin directory is on the PATH', () => {
    const home = mkdtempSync(join(tmpdir(), 'shx-doc-'));
    dirs.push(home);
    const bin = join(home, 'bin');
    mkdirSync(join(home, 'app'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'shibaox'), '#!/bin/sh\n');
    const onPath = installLine({ root: home, env: { PATH: `${bin}:/usr/bin` } });
    expect(onPath).toMatchObject({ name: 'install', ok: true });
    expect(onPath.detail).toContain(join(home, 'app'));
    const offPath = installLine({ root: home, env: { PATH: '/usr/bin' } });
    expect(offPath.ok).toBe(false);
    expect(offPath.detail).toContain(bin);
    expect(offPath.detail).toMatch(/PATH/);
    // a development checkout (no app dir, no bin): reported as such, not as a fault
    const dev = installLine({ root: join(home, 'nothing'), env: { PATH: '/usr/bin' } });
    expect(dev).toMatchObject({ ok: true });
    expect(dev.detail).toMatch(/checkout|install\.sh/);
  });
});
