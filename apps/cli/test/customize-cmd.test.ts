import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, type HiggsfieldProbe, homePaths } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noHiggsfield: HiggsfieldProbe = {
  exec: async () => ({ exitCode: 127, stdout: '', stderr: '' }),
  mcp: async () => 'unreachable',
  login: async () => ({ started: false }),
};

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cli-cust-'));
  tmp.push(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const daemon = new Daemon({
    discovery: false,
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: { PATH: process.env.PATH, HOME: dir },
    log: () => {},
    version: '0.2.14',
    higgsfield: noHiggsfield,
    claudeInstalled: false,
  });
  daemons.push(daemon);
  await daemon.start();
  const cli = (...args: string[]) =>
    new Promise<Result>((resolve) => {
      execFile(
        process.execPath,
        [bin, ...args],
        {
          env: {
            PATH: process.env.PATH ?? '',
            SHIBAOX_HOME: home.root,
            HOME: dir,
            SHIBAOX_NO_AUTOSTART: '1',
          },
        },
        (err, stdout, stderr) =>
          resolve({
            code: (err as { code?: number } | null)?.code ?? 0,
            stdout: String(stdout),
            stderr: String(stderr),
          }),
      );
    });
  expect((await cli('init', dir)).code).toBe(0);
  return { dir, org: join(dir, 'org'), cli };
}

describe('customize commands', () => {
  it('skills list, add from a folder, rm with and without --detach', async () => {
    const { dir, org, cli } = await setup();
    const list = await cli('skills', 'list', '--org', org);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/higgsfield\s+.*used by: assistant/);
    const folder = join(dir, 'my-skills', 'notes');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: Notes\ndescription: Take notes\n---\n');
    const add = await cli('skills', 'add', join(dir, 'my-skills'), '--org', org);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain('added notes');
    expect(existsSync(join(org, 'skills/notes/SKILL.md'))).toBe(true);
    const again = await cli('skills', 'add', join(dir, 'my-skills'), '--org', org);
    expect(again.stdout).toContain('skipped notes (exists)');
    const used = await cli('skills', 'rm', 'higgsfield', '--org', org);
    expect(used.code).toBe(1);
    expect(used.stdout + used.stderr).toMatch(/assistant.*--detach/s);
    const rm = await cli('skills', 'rm', 'higgsfield', '--detach', '--org', org);
    expect(rm.code).toBe(0);
    expect(existsSync(join(org, 'skills/higgsfield'))).toBe(false);
    const json = await cli('--json', 'skills', 'list', '--org', org);
    expect(
      json.stdout
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { id: string }).id),
    ).toEqual(['higgsfield-app', 'notes']);
    // a built-in skill comes back from Shibaox's own text; an existing one only with --replace
    const builtin = await cli('skills', 'add', 'higgsfield', '--builtin', '--org', org);
    expect(builtin.code).toBe(0);
    expect(builtin.stdout).toContain('added higgsfield');
    const kept = await cli('skills', 'add', 'higgsfield-app', '--builtin', '--org', org);
    expect(kept.stdout).toMatch(/skipped higgsfield-app \(exists\).*--replace/);
    const replaced = await cli(
      'skills',
      'add',
      'higgsfield-app',
      '--builtin',
      '--replace',
      '--org',
      org,
    );
    expect(replaced.stdout).toContain('written higgsfield-app');
    const unknown = await cli('skills', 'add', 'nope', '--builtin', '--org', org);
    expect(unknown.code).toBe(1);
    const bad = await cli('skills', 'add', 'anthropics/skills', '--replace', '--org', org);
    expect(bad.code).not.toBe(0);
    expect(bad.stdout + bad.stderr).toMatch(/--replace works only with --builtin/);
  });

  it('mcp add (url and command), roles list, mcp rm, plugins', async () => {
    const { org, cli } = await setup();
    const add = await cli(
      'mcp',
      'add',
      'github',
      '--url',
      'https://api.githubcopilot.com/mcp/',
      '--header',
      `Authorization=Bearer \${GH_TOKEN}`,
      '--role',
      'backend',
      '--description',
      'GitHub',
      '--org',
      org,
    );
    expect(add.code, add.stderr).toBe(0);
    expect(add.stdout).toMatch(/github.*http.*roles: backend.*missing GH_TOKEN/);
    const yaml = readFileSync(join(org, 'catalog/github.yaml'), 'utf8');
    expect(yaml).toContain(`Authorization: Bearer \${GH_TOKEN}`);
    const stdio = await cli(
      'mcp',
      'add',
      'fetch',
      '--command',
      'uvx',
      '--arg',
      'mcp-server-fetch',
      '--tool',
      'fetch',
      '--org',
      org,
    );
    expect(stdio.code, stdio.stderr).toBe(0);
    const dup = await cli('mcp', 'add', 'fetch', '--command', 'x', '--org', org);
    expect(dup.code).toBe(1);
    expect(dup.stdout + dup.stderr).toMatch(/fetch exists \(use --replace\)/);
    const roles = await cli('roles', 'list', '--org', org);
    expect(roles.stdout).toMatch(/backend\s+.*mcp: github/);
    const rm = await cli('mcp', 'rm', 'github', '--org', org);
    expect(rm.code).toBe(0);
    expect((await cli('roles', 'list', '--org', org)).stdout).not.toMatch(/mcp: github/);
    const plugins = await cli('plugins');
    expect(plugins.code).toBe(0);
    expect(plugins.stdout).toMatch(/higgsfield\s+off/i);
    expect(plugins.stdout).toMatch(/telegram/i);
  });
});
