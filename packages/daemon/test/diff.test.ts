import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonHttpError } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { diffWorkspace, worktreeBase } from '../src/runs/diff.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'diff-'));
  tmp.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"test":"node -e 0"}}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

describe('diffWorkspace', () => {
  it('lists modified and untracked files with counts and a patch', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\nexport const c = 2;\n');
    const d = await diffWorkspace(dir);
    expect(d).toBeDefined();
    if (!d) return;
    expect(d.base).toBe('HEAD');
    expect(d.truncated).toBe(false);
    expect(d.files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'b.ts', status: 'added', additions: 2, deletions: 0 },
    ]);
    expect(d.patch).toContain('diff --git a/a.ts b/a.ts');
    expect(d.patch).toContain('+export const a = 2;');
    expect(d.patch).toContain('diff --git a/b.ts b/b.ts');
    expect(d.patch).toContain('+export const c = 2;');
  });

  it('is empty for a clean tree, undefined for a missing directory, and truncates huge patches', async () => {
    const dir = repo();
    const clean = await diffWorkspace(dir);
    expect(clean?.files).toEqual([]);
    expect(clean?.patch).toBe('');
    expect(await diffWorkspace(join(dir, 'nope'))).toBeUndefined();
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(3_000_000));
    const big = await diffWorkspace(dir, { maxChars: 100_000 });
    expect(big?.truncated).toBe(true);
    expect(big?.patch.length).toBeLessThanOrEqual(100_000 + 20);
  });
});

describe('worktree runs', () => {
  it('diffs against the fork point so committed work on the run branch shows', async () => {
    const dir = repo();
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
    const wt = join(dir, '.shibaox', 'worktrees', 'run-1');
    git(dir, 'worktree', 'add', '-q', '-b', 'shibaox/run-1', wt);
    writeFileSync(join(wt, 'a.ts'), 'export const a = 5;\n');
    git(wt, 'commit', '-q', '-am', 'agent work');
    writeFileSync(join(wt, 'c.ts'), 'export const c = 1;\n');
    const base = await worktreeBase(wt, dir);
    expect(base).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    const d = await diffWorkspace(wt, { base });
    expect(d?.base).toBe(base);
    expect(d?.files.map((f) => `${f.status} ${f.path}`)).toEqual(['modified a.ts', 'added c.ts']);
    expect(d?.patch).toContain('+export const a = 5;');
    expect(await diffWorkspace(wt)).toMatchObject({ files: [{ path: 'c.ts', status: 'added' }] }); // HEAD only sees the uncommitted file
  });
});

describe('GET /runs/:id/diff', () => {
  it('serves the run workspace diff through the client and 404s an unknown run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'diff-srv-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const project = repo();
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
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
    writeFileSync(join(project, 'a.ts'), 'export const a = 3;\n');
    const d = await client.diff(runId);
    expect(d.files.map((f) => f.path)).toContain('a.ts');
    expect(d.patch).toContain('+export const a = 3;');
    await expect(client.diff('nope')).rejects.toMatchObject({ status: 404 });
    rmSync(project, { recursive: true, force: true });
    await expect(client.diff(runId)).rejects.toSatisfy(
      (e: unknown) => e instanceof DaemonHttpError && e.status === 404 && e.code === 'no_workspace',
    );
  });
});
