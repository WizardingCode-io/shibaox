import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { Daemon, DaemonClient, homePaths, scaffoldOrg } from '@wizardingcode/shibaox-daemon';
import { afterEach, describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const cli = (env: Record<string, string>, ...args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      [bin, ...args],
      { env: { PATH: process.env.PATH ?? '', SHIBAOX_NO_AUTOSTART: '1', ...env } },
      (err, stdout, stderr) =>
        resolve({
          code: (err as { code?: number } | null)?.code ?? 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });

describe('shibaox files', () => {
  it('lists the files of a run, prints one, and saves it with --out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-files-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const project = join(dir, 'proj');
    execFileSync('git', ['init', '-q', project]);
    for (const [k, v] of [
      ['user.email', 't@t'],
      ['user.name', 't'],
    ])
      execFileSync('git', ['-C', project, 'config', k as string, v as string]);
    writeFileSync(join(project, 'package.json'), '{"name":"p","scripts":{"test":"node -e 0"}}\n');
    execFileSync('git', ['-C', project, 'add', '.']);
    execFileSync('git', ['-C', project, 'commit', '-q', '-m', 'init']);
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '0.2.19',
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new DaemonClient(home.socket);
    const { runId } = await client.submitRun({
      orgRoot: join(dir, 'org'),
      project,
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'mock',
      workspace: 'inplace',
    });
    for (let i = 0; i < 100; i++) {
      const s = await client.getRun(runId);
      if (s.status === 'completed' || s.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    writeFileSync(join(project, 'report.md'), '# Report\n');
    const env = { SHIBAOX_HOME: home.root, HOME: dir };
    const list = await cli(env, 'files', runId);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('added    report.md (9 B)');
    const one = await cli(env, 'files', runId, 'report.md');
    expect(one.stdout).toBe('# Report\n');
    const out = join(dir, 'saved.md');
    const saved = await cli(env, 'files', runId, 'report.md', '--out', out);
    expect(saved.code).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('# Report\n');
    const bad = await cli(env, 'files', runId, '../x');
    expect(bad.code).not.toBe(0);
  });
});
