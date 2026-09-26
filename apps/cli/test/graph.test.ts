import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { runArgv } from '@shibaox/core';
import { Graphify } from '@shibaox/memory';
import { describe, expect, it } from 'vitest';
import { graphBuild, graphQuery, graphUpdate } from '../src/commands/graph.js';

type Exec = typeof runArgv;
const fake =
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

const project = () => mkdtempSync(join(tmpdir(), 'graph-cmd-'));

describe('shibaox graph', () => {
  it('build prints the install failure without throwing', async () => {
    const lines: string[] = [];
    const g = new Graphify({ exec: fake(() => ({ exitCode: 127, stderr: 'not found' })) });
    const code = await graphBuild(
      { project: project() },
      { graphify: g, log: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/uv not found: install uv/);
  });

  it('build prints the extract failure without throwing', async () => {
    const lines: string[] = [];
    const g = new Graphify({
      exec: fake((argv) =>
        argv[1] === 'extract' ? { exitCode: 2, stderr: 'boom' } : { exitCode: 0 },
      ),
    });
    const code = await graphBuild(
      { project: project() },
      { graphify: g, log: (l) => lines.push(l) },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/graphify extract failed: boom/);
  });

  it('build reports the graph path on success', async () => {
    const dir = project();
    const lines: string[] = [];
    const g = new Graphify({
      exec: fake((argv) => {
        if (argv[1] === 'extract') {
          mkdirSync(join(dir, 'graphify-out'), { recursive: true });
          writeFileSync(join(dir, 'graphify-out', 'graph.json'), '{}');
        }
        return { exitCode: 0 };
      }),
    });
    const code = await graphBuild({ project: dir }, { graphify: g, log: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines).toContain(`graph: ${join(dir, 'graphify-out', 'graph.json')}`);
  });

  it('update reports failures', async () => {
    const lines: string[] = [];
    const g = new Graphify({
      exec: fake((argv) => (argv[1] === 'update' ? { exitCode: 1, stderr: 'x' } : { exitCode: 0 })),
    });
    expect(
      await graphUpdate({ project: project() }, { graphify: g, log: (l) => lines.push(l) }),
    ).toBe(1);
    expect(lines.join('\n')).toMatch(/graphify update failed/);
  });

  it('query returns the text, and asks for a build when there is no graph', async () => {
    const dir = project();
    const lines: string[] = [];
    const g = new Graphify({
      exec: fake((argv) =>
        argv[1] === 'query' ? { exitCode: 0, stdout: 'add() lives in math.js\n' } : { exitCode: 0 },
      ),
    });
    expect(
      await graphQuery(
        'where is add?',
        { project: dir },
        { graphify: g, log: (l) => lines.push(l) },
      ),
    ).toBe(1);
    expect(lines.join('\n')).toMatch(/no graph at .*graph.json: run shibaox graph build/);
    mkdirSync(join(dir, 'graphify-out'));
    writeFileSync(join(dir, 'graphify-out', 'graph.json'), '{}');
    lines.length = 0;
    expect(
      await graphQuery(
        'where is add?',
        { project: dir },
        { graphify: g, log: (l) => lines.push(l) },
      ),
    ).toBe(0);
    expect(lines).toEqual(['add() lives in math.js']);
  });
});
