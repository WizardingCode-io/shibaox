import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { runArgv } from '@shibaox/core';
import { afterEach, describe, expect, it } from 'vitest';
import { Graphify, graphJsonPath } from '../src/index.js';

type Exec = typeof runArgv;
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fakeExec =
  (script: (argv: string[]) => { exitCode: number; stdout?: string; stderr?: string }): Exec =>
  async ({ argv }) => {
    const r = script(argv);
    return {
      exitCode: r.exitCode,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      timedOut: false,
    };
  };

describe('Graphify (fake exec)', () => {
  it('reports not installed and explains how to install when uv is missing', async () => {
    const g = new Graphify({
      exec: fakeExec((argv) =>
        argv[0] === 'graphify'
          ? { exitCode: 127 }
          : argv[0] === 'uv'
            ? { exitCode: 127 }
            : { exitCode: 0 },
      ),
    });
    expect(await g.isInstalled()).toBe(false);
    const r = await g.ensureInstalled();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('uv tool install graphifyy');
  });
  it('build runs extract --code-only and returns the graph path when produced', async () => {
    const project = mkdtempSync(join(tmpdir(), 'p-'));
    tmpDirs.push(project);
    const calls: string[][] = [];
    const g = new Graphify({
      exec: fakeExec((argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: 'ok' };
      }),
    });
    const r = await g.build(project);
    expect(
      calls.some((c) => c[0] === 'graphify' && c[1] === 'extract' && c.includes('--code-only')),
    ).toBe(true);
    expect(r.ok).toBe(false); // no graph.json was produced by the fake
    expect(r.message).toContain('graph.json');
  });
  it('resolves a relative project to an absolute path for both argv and cwd', async () => {
    const calls: { argv: string[]; cwd: string }[] = [];
    const g = new Graphify({
      exec: async ({ argv, cwd }) => {
        calls.push({ argv, cwd });
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      },
    });
    await g.build('relative/dir');
    const abs = resolve('relative/dir');
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cwd).toBe(abs);
    expect(call?.argv).toContain(abs);
  });
  it('mcpServerConfig points python at graphify.serve', () => {
    expect(
      new Graphify().mcpServerConfig('/p/graphify-out/graph.json', '/usr/bin/python3'),
    ).toEqual({
      type: 'stdio',
      command: '/usr/bin/python3',
      args: ['-m', 'graphify.serve', '/p/graphify-out/graph.json'],
    });
  });
});

// real external tools only run behind SHIBAOX_REAL_TESTS=1
const realTests = process.env.SHIBAOX_REAL_TESTS === '1';
const hasGraphify = (() => {
  if (!realTests) return false;
  try {
    execFileSync('graphify', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
describe.skipIf(!realTests || !hasGraphify)('Graphify (real, local AST only)', () => {
  it('builds a graph for the sample repo and answers a query', async () => {
    const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
    const project = mkdtempSync(join(tmpdir(), 'gp-'));
    tmpDirs.push(project);
    cpSync(sample, project, { recursive: true });
    const g = new Graphify();
    const r = await g.build(project);
    expect(r.ok, r.message).toBe(true);
    expect(existsSync(graphJsonPath(project))).toBe(true);
    const answer = await g.query(project, 'what does add do?');
    expect(answer.length).toBeGreaterThan(0);
  }, 120_000);
});
