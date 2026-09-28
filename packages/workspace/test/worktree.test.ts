import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRunWorkspace,
  diffRunWorkspace,
  isGitRepo,
  listRunWorkspaces,
  removeRunWorkspace,
  worktreePreflight,
} from '../src/index.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('run workspaces', () => {
  it('detects git repos', async () => {
    expect(await isGitRepo(repo())).toBe(true);
    expect(await isGitRepo(mkdtempSync(join(tmpdir(), 'plain-')))).toBe(false);
  });
  it('creates a worktree on its own branch and never touches the main checkout', async () => {
    const project = repo();
    const ws = await createRunWorkspace({ project, runId: 'r1', mode: 'worktree' });
    expect(ws.mode).toBe('worktree');
    expect(ws.branch).toBe('shibaox/r1');
    expect(ws.path).toBe(join(project, '.shibaox', 'worktrees', 'r1'));
    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    expect(existsSync(join(project, 'b.txt'))).toBe(false);
    const exclude = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.shibaox/\n');
    expect(exclude).toContain('graphify-out/\n');
    const diff = await diffRunWorkspace(ws.path);
    expect(diff).toContain('b.txt');
    // a new file the agent wrote (untracked) shows with its content, like any other addition
    expect(diff).toContain('+++ b/b.txt');
    expect(diff).toContain('+b');
    const list = await listRunWorkspaces(project);
    expect(list.map((w) => w.runId)).toEqual(['r1']);
    await removeRunWorkspace({ project, runId: 'r1', deleteBranch: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(await listRunWorkspaces(project)).toEqual([]);
  });
  it('inplace returns the project path', async () => {
    const project = repo();
    expect(await createRunWorkspace({ project, runId: 'r2', mode: 'inplace' })).toEqual({
      path: project,
      mode: 'inplace',
    });
  });
  it('refuses worktree mode outside a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    await expect(
      createRunWorkspace({ project: plain, runId: 'r3', mode: 'worktree' }),
    ).rejects.toThrow(/not a git repository; use --workspace inplace/);
  });
  it('rejects a path-escaping runId and creates nothing', async () => {
    const project = repo();
    await expect(createRunWorkspace({ project, runId: '../x', mode: 'worktree' })).rejects.toThrow(
      /invalid runId "\.\.\/x"/,
    );
    expect(existsSync(join(project, '.shibaox'))).toBe(false);
    await expect(removeRunWorkspace({ project, runId: 'a/b' })).rejects.toThrow(
      /invalid runId "a\/b"/,
    );
  });
  it('resolves the git common dir when the project is itself a worktree', async () => {
    const main = repo();
    const outer = join(mkdtempSync(join(tmpdir(), 'holder-')), 'outer');
    execFileSync('git', ['worktree', 'add', '-q', outer, '-b', 'outer'], { cwd: main });
    const ws = await createRunWorkspace({ project: outer, runId: 'r5', mode: 'worktree' });
    expect(ws.mode).toBe('worktree');
    expect(existsSync(join(outer, '.git'))).toBe(true);
    expect(readFileSync(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.shibaox/');
  });
});

describe('worktreePreflight', () => {
  it('accepts a committed repo and a tracked subfolder', async () => {
    const project = repo();
    mkdirSync(join(project, 'app'));
    writeFileSync(join(project, 'app', 'x.txt'), 'x\n');
    execFileSync('git', ['add', '.'], { cwd: project });
    execFileSync('git', ['commit', '-q', '-m', 'app'], { cwd: project });
    expect(await worktreePreflight(project)).toEqual({ ok: true });
    expect(await worktreePreflight(join(project, 'app'))).toEqual({ ok: true });
  });
  it('refuses a repo with no commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'empty-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    expect(await worktreePreflight(dir)).toEqual({ ok: false, reason: 'project has no commits' });
  });
  it('refuses a subfolder that is not tracked at HEAD', async () => {
    const project = repo();
    mkdirSync(join(project, 'untracked'));
    writeFileSync(join(project, 'untracked', 'y.txt'), 'y\n');
    expect(await worktreePreflight(join(project, 'untracked'))).toEqual({
      ok: false,
      reason: 'project "untracked" is not tracked at HEAD',
    });
  });
});

describe('diffRunWorkspace and new files', () => {
  it('shows new files whatever their name, scoped to a subfolder project, with a cap on how many', async () => {
    const project = repo();
    mkdirSync(join(project, 'sub'));
    writeFileSync(join(project, 'sub', 'keep.txt'), 'k\n');
    execFileSync('git', ['add', '-A'], { cwd: project });
    execFileSync(
      'git',
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--no-gpg-sign', '-m', 'sub'],
      { cwd: project },
    );
    const ws = await createRunWorkspace({ project, runId: 'r2', mode: 'worktree' });
    writeFileSync(join(ws.path, 'sub', 'a b.txt'), 'space\n');
    writeFileSync(join(ws.path, 'sub', 'é.txt'), 'accent\n');
    writeFileSync(join(ws.path, 'outside.txt'), 'outside\n');
    const diff = await diffRunWorkspace(join(ws.path, 'sub'));
    expect(diff).toContain('+space');
    expect(diff).toContain('+accent');
    expect(diff).not.toContain('+outside'); // outside the project folder
    for (let i = 0; i < 230; i++) writeFileSync(join(ws.path, 'sub', `f${i}.txt`), `${i}\n`);
    const many = await diffRunWorkspace(join(ws.path, 'sub'));
    expect(many).toMatch(/…\d+ more new file\(s\) not shown/);
    expect((many.match(/^\+\+\+ b\//gm) ?? []).length).toBeLessThanOrEqual(200);
  });
});
