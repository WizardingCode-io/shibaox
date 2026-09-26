import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createRunWorkspace,
  diffRunWorkspace,
  isGitRepo,
  listRunWorkspaces,
  removeRunWorkspace,
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
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.shibaox/');
    const diff = await diffRunWorkspace(ws.path);
    expect(diff).toContain('b.txt');
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
});
