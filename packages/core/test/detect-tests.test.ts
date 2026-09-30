import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectLintCommand, detectSetupCommand, detectTestCommand } from '../src/gates/detect.js';
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

describe('detectLintCommand', () => {
  it("prefers the project's own lint script, then the linter it is configured for", () => {
    const pkg = JSON.stringify({ scripts: { lint: 'biome check .' } });
    expect(detectLintCommand(dir({ 'package.json': pkg, 'pnpm-lock.yaml': '' }))).toBe(
      'pnpm run lint',
    );
    expect(detectLintCommand(dir({ 'package.json': pkg }))).toBe('npm run lint');
    // never download a tool: `--no` runs what is installed (the real Biome package, not npm's "biome")
    expect(detectLintCommand(dir({ 'package.json': '{}', 'biome.json': '{}' }))).toBe(
      'npx --no @biomejs/biome check .',
    );
    expect(detectLintCommand(dir({ 'biome.jsonc': '{}' }))).toBe('npx --no @biomejs/biome check .');
    expect(detectLintCommand(dir({ 'package.json': '{}', 'eslint.config.js': '' }))).toBe(
      'npx --no eslint .',
    );
    expect(detectLintCommand(dir({ 'package.json': '{}', 'eslint.config.mts': '' }))).toBe(
      'npx --no eslint .',
    );
    expect(detectLintCommand(dir({ 'package.json': '{}', '.eslintrc.json': '{}' }))).toBe(
      'npx --no eslint .',
    );
    // the project's own make target beats a guessed default
    expect(detectLintCommand(dir({ 'go.mod': 'module x', Makefile: 'lint:\n\techo ok\n' }))).toBe(
      'make lint',
    );
    expect(detectLintCommand(dir({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n' }))).toBe(
      'ruff check .',
    );
    expect(detectLintCommand(dir({ 'ruff.toml': '' }))).toBe('ruff check .');
    expect(detectLintCommand(dir({ 'pyproject.toml': '[tool.poetry]\n' }))).toBeUndefined();
    expect(detectLintCommand(dir({ 'composer.json': '{}', 'phpstan.neon': '' }))).toBe(
      'vendor/bin/phpstan analyse --no-progress',
    );
    expect(detectLintCommand(dir({ 'go.mod': 'module x', '.golangci.yml': '' }))).toBe(
      'golangci-lint run',
    );
    expect(detectLintCommand(dir({ 'go.mod': 'module x' }))).toBe('go vet ./...');
    expect(detectLintCommand(dir({ 'Cargo.toml': '' }))).toBe(
      'cargo clippy --quiet -- -D warnings',
    );
    expect(detectLintCommand(dir({ Makefile: 'lint:\n\techo ok\n' }))).toBe('make lint');
    expect(detectLintCommand(dir({ 'README.md': '' }))).toBeUndefined();
  });
});

describe('the lint check', () => {
  const ctx = (workspace: string) =>
    ({ runId: 'r', nodeId: 'qa', workspace, state: {} as never, log: () => {} }) as never;
  const gate = (check: Record<string, unknown>) => ({
    quality: {
      gate: 'quality',
      checks: [{ name: 'lint', type: 'lint', timeout_ms: 60_000, ...check }],
    },
  });
  it('runs the detected linter, or the command given, and reports it', async () => {
    const d = dir({
      'package.json': JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }),
    });
    const report = await runGate({
      gates: gate({}) as never,
      gateIds: ['quality'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(report.passed).toBe(true);
    expect(report.checks[0]).toMatchObject({ type: 'lint', passed: true, skipped: false });
    expect(report.checks[0]?.evidence).toContain('npm run lint');
    const failing = await runGate({
      gates: gate({
        command: 'node -e "console.error(\'x.ts:3 unused var\'); process.exit(1)"',
      }) as never,
      gateIds: ['quality'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(failing.passed).toBe(false);
    expect(failing.checks[0]).toMatchObject({ type: 'lint', passed: false });
    expect(failing.checks[0]?.evidence).toContain('unused var');
    expect(failing.checks[0]?.suggestion).toContain('exits 0');
  });
  it('a linter that is not installed is a skipped pass with a note, never a failure to fix', async () => {
    const d = dir({ 'README.md': '' });
    for (const command of [
      'definitely-not-a-linter-xyz check .',
      'npx --no @biomejs/biome check .',
    ]) {
      const report = await runGate({
        gates: gate({ command }) as never,
        gateIds: ['quality'],
        runners: defaultCheckRunners(),
        ctx: ctx(d),
      });
      expect(report.checks[0]).toMatchObject({ type: 'lint', passed: true, skipped: true });
      expect(report.checks[0]?.evidence).toMatch(/not available/);
    }
  });
  it('a project without a linter passes with a note', async () => {
    const d = dir({ 'README.md': '' });
    const report = await runGate({
      gates: gate({}) as never,
      gateIds: ['quality'],
      runners: defaultCheckRunners(),
      ctx: ctx(d),
    });
    expect(report.checks[0]).toMatchObject({ type: 'lint', passed: true, skipped: true });
    expect(report.checks[0]?.evidence).toContain('no linter');
  });
});

describe('detectSetupCommand', () => {
  const pkg = JSON.stringify({ name: 'p' });
  it('installs from a lockfile, frozen, so nothing a later commit would pick up is written', () => {
    expect(detectSetupCommand(dir({ 'package.json': pkg, 'pnpm-lock.yaml': '' }))).toEqual({
      command: 'pnpm install --frozen-lockfile',
      cwd: '.',
    });
    expect(detectSetupCommand(dir({ 'package.json': pkg, 'yarn.lock': '' }))?.command).toBe(
      'yarn install --frozen-lockfile',
    );
    expect(detectSetupCommand(dir({ 'package.json': pkg, 'bun.lock': '' }))?.command).toBe(
      'bun install --frozen-lockfile',
    );
    expect(detectSetupCommand(dir({ 'package.json': pkg, 'package-lock.json': '' }))?.command).toBe(
      'npm ci',
    );
    expect(detectSetupCommand(dir({ 'package.json': pkg }))?.command).toBe(
      'npm install --no-package-lock',
    );
    expect(detectSetupCommand(dir({ 'pyproject.toml': '', 'uv.lock': '' }))?.command).toBe(
      'uv sync --frozen',
    );
    expect(detectSetupCommand(dir({ 'pyproject.toml': '' }))).toBeUndefined(); // no lockfile: uv would write one
    expect(detectSetupCommand(dir({ 'requirements.txt': 'x' }))).toBeUndefined(); // pip needs a venv: not ours to guess
    expect(detectSetupCommand(dir({ 'composer.json': '{}', 'composer.lock': '{}' }))?.command).toBe(
      'composer install --no-interaction',
    );
    expect(detectSetupCommand(dir({ 'composer.json': '{}' }))).toBeUndefined();
    expect(detectSetupCommand(dir({ 'go.mod': 'module x', 'go.sum': '' }))?.command).toBe(
      'go mod download',
    );
    expect(detectSetupCommand(dir({ 'Cargo.toml': '', 'Cargo.lock': '' }))?.command).toBe(
      'cargo fetch --locked',
    );
    expect(detectSetupCommand(dir({ Gemfile: '', 'Gemfile.lock': '' }))?.command).toBe(
      'bundle install',
    );
    expect(detectSetupCommand(dir({ 'README.md': '' }))).toBeUndefined();
  });
  it('a project in a subdirectory of a monorepo installs where the lockfile is', () => {
    const root = dir({ 'pnpm-lock.yaml': '', 'package.json': pkg, 'apps/web/package.json': pkg });
    expect(detectSetupCommand(join(root, 'apps', 'web'), root)).toEqual({
      command: 'pnpm install --frozen-lockfile',
      cwd: '../..',
    });
    const npm = dir({ 'package-lock.json': '', 'package.json': pkg, 'apps/web/package.json': pkg });
    expect(detectSetupCommand(join(npm, 'apps', 'web'), npm)).toEqual({
      command: 'npm ci',
      cwd: '../..',
    });
    // nothing above the project: the project's own manifest decides
    const own = dir({ 'apps/web/package.json': pkg, 'apps/web/yarn.lock': '' });
    expect(detectSetupCommand(join(own, 'apps', 'web'), own)).toEqual({
      command: 'yarn install --frozen-lockfile',
      cwd: '.',
    });
  });
  it('the project file wins: its setup, or none when it says false', () => {
    expect(
      detectSetupCommand(dir({ 'package.json': pkg, 'shibaox.yaml': 'setup: make deps\n' })),
    ).toEqual({ command: 'make deps', cwd: '.' });
    expect(
      detectSetupCommand(dir({ 'package.json': pkg, 'shibaox.yaml': 'setup: false\n' })),
    ).toBeUndefined();
  });
});

describe('the project file and the checks', () => {
  it('tests and lint from shibaox.yaml come before detection', () => {
    const d = dir({
      'package.json': JSON.stringify({ scripts: { test: 'x', lint: 'y' } }),
      'shibaox.yaml': 'tests: make check\nlint: make style\n',
    });
    expect(detectTestCommand(d)).toBe('make check');
    expect(detectLintCommand(d)).toBe('make style');
  });
});
