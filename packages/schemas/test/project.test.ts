import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProjectFile, ProjectFileSchema } from '../src/index.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('the project file (shibaox.yaml)', () => {
  it('parses setup, tests, lint and protected; setup can be turned off', () => {
    expect(
      ProjectFileSchema.parse({
        setup: 'pnpm install --frozen-lockfile',
        setup_timeout_ms: 120_000,
        tests: 'pnpm test',
        lint: 'pnpm lint',
        protected: ['.github/**', 'package.json'],
      }),
    ).toEqual({
      setup: 'pnpm install --frozen-lockfile',
      setup_timeout_ms: 120_000,
      tests: 'pnpm test',
      lint: 'pnpm lint',
      protected: ['.github/**', 'package.json'],
    });
    expect(ProjectFileSchema.parse({ setup: false })).toEqual({ setup: false, protected: [] });
    expect(ProjectFileSchema.parse({})).toEqual({ protected: [] });
    expect(() => ProjectFileSchema.parse({ setup: '' })).toThrow();
    expect(() => ProjectFileSchema.parse({ tests: 3 })).toThrow();
  });
  it('loads it from a project directory, names the file on errors, and is absent when missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-proj-'));
    const d = dir;
    expect(loadProjectFile(d)).toBeUndefined();
    writeFileSync(join(d, 'shibaox.yaml'), 'setup: npm ci\ntests: npm test\n');
    expect(loadProjectFile(d)).toEqual({ setup: 'npm ci', tests: 'npm test', protected: [] });
    writeFileSync(join(d, 'shibaox.yaml'), 'setup: [1]\n');
    expect(() => loadProjectFile(d)).toThrow(/shibaox\.yaml/);
  });
});
