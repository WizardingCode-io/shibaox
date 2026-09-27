import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectTestCommand } from '../src/gates/detect.js';
import { defaultCheckRunners, runGate } from '../src/gates/engine.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'detect-'));
  dirs.push(d);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), content);
  }
  return d;
}

describe('detectTestCommand', () => {
  it('picks the package manager of a Node project from its lockfile', () => {
    const pkg = JSON.stringify({ scripts: { test: 'node --test' } });
    expect(detectTestCommand(dir({ 'package.json': pkg, 'pnpm-lock.yaml': '' }))).toBe('pnpm test');
    expect(detectTestCommand(dir({ 'package.json': pkg, 'yarn.lock': '' }))).toBe('yarn test');
    expect(detectTestCommand(dir({ 'package.json': pkg, 'bun.lock': '' }))).toBe('bun test');
    expect(detectTestCommand(dir({ 'package.json': pkg }))).toBe('npm test');
    expect(
      detectTestCommand(dir({ 'package.json': JSON.stringify({ scripts: {} }) })),
    ).toBeUndefined();
  });
  it('knows the other common runners', () => {
    expect(detectTestCommand(dir({ 'pyproject.toml': '' }))).toBe('pytest');
    expect(detectTestCommand(dir({ 'go.mod': 'module x' }))).toBe('go test ./...');
    expect(detectTestCommand(dir({ 'Cargo.toml': '' }))).toBe('cargo test');
    expect(detectTestCommand(dir({ Makefile: 'build:\n\techo\ntest:\n\techo ok\n' }))).toBe(
      'make test',
    );
    expect(detectTestCommand(dir({ Makefile: 'build:\n\techo\n' }))).toBeUndefined();
    expect(detectTestCommand(dir({ 'composer.json': '{}', artisan: '' }))).toBe('php artisan test');
    expect(detectTestCommand(dir({ 'composer.json': '{}', 'phpunit.xml': '' }))).toBe(
      'vendor/bin/phpunit',
    );
    expect(detectTestCommand(dir({ Gemfile: '', 'spec/a_spec.rb': '' }))).toBe('bundle exec rspec');
    expect(detectTestCommand(dir({ 'README.md': '' }))).toBeUndefined();
  });
});

describe('the tests check', () => {
  const ctx = (workspace: string) =>
    ({ runId: 'r', nodeId: 'qa', workspace, state: {} as never, log: () => {} }) as never;
  it('runs the detected runner and reports it', async () => {
    const d = dir({
      'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    });
    const report = await runGate({
      gates: {
        tests: {
          gate: 'tests',
          checks: [{ name: 'unit-tests', type: 'tests', timeout_ms: 60_000 }],
        },
      },
      gateIds: ['tests'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(report.passed).toBe(true);
    expect(report.checks[0]).toMatchObject({ type: 'tests', passed: true, skipped: false });
    expect(report.checks[0]?.evidence).toContain('npm test');
  });
  it('fails when the runner fails', async () => {
    const d = dir({
      'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(3)"' } }),
    });
    const report = await runGate({
      gates: {
        tests: {
          gate: 'tests',
          checks: [{ name: 'unit-tests', type: 'tests', timeout_ms: 60_000 }],
        },
      },
      gateIds: ['tests'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(report.passed).toBe(false);
    expect(report.checks[0]?.evidence).toContain('exit 3');
  });
  it('passes with a note when the project has no test runner', async () => {
    const d = dir({ 'README.md': '' });
    const report = await runGate({
      gates: {
        tests: {
          gate: 'tests',
          checks: [{ name: 'unit-tests', type: 'tests', timeout_ms: 60_000 }],
        },
      },
      gateIds: ['tests'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(report.passed).toBe(true);
    expect(report.checks[0]).toMatchObject({ passed: true, skipped: true });
    expect(report.checks[0]?.evidence).toContain('no test runner found');
  });
});
