import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { loadProjectFile, type ProjectFile } from '@wizardingcode/shibaox-schemas';

const has = (dir: string, file: string) => existsSync(join(dir, file));

/** The project's own answers (`shibaox.yaml`); an unreadable file counts as none here. */
function projectFile(dir: string): ProjectFile | undefined {
  try {
    return loadProjectFile(dir);
  } catch {
    return undefined;
  }
}

/** Default time for a dependency install (10 min). */
export const SETUP_TIMEOUT_MS = 600_000;

/** A dependency install: the command, and where to run it relative to the workspace. */
export interface SetupPlan {
  command: string;
  /** `.` for the workspace itself, else a relative path to the directory holding the lockfile. */
  cwd: string;
}

/** The frozen install a lockfile in `dir` calls for; only a manifest without one for npm (no lockfile written). */
function lockfileInstall(dir: string, manifestOnly: boolean): string | undefined {
  if (has(dir, 'package.json')) {
    if (has(dir, 'pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
    if (has(dir, 'yarn.lock')) return 'yarn install --frozen-lockfile';
    if (has(dir, 'bun.lock') || has(dir, 'bun.lockb')) return 'bun install --frozen-lockfile';
    if (has(dir, 'package-lock.json')) return 'npm ci';
    if (manifestOnly) return 'npm install --no-package-lock';
  }
  if (has(dir, 'uv.lock')) return 'uv sync --frozen';
  if (has(dir, 'composer.lock')) return 'composer install --no-interaction';
  if (has(dir, 'go.mod')) return 'go mod download';
  if (has(dir, 'Cargo.lock')) return 'cargo fetch --locked';
  if (has(dir, 'Gemfile.lock')) return 'bundle install';
  return undefined;
}

/**
 * The install a fresh checkout of `dir` needs before tests and linters run for real:
 * `shibaox.yaml setup` in `dir` first (`false` means none), else the lockfile of `dir` or of
 * a directory above it up to `root` (a monorepo package installs where the lockfile is),
 * always frozen so nothing a later commit would pick up is written; a Node manifest with no
 * lockfile anywhere installs without writing one. Python without `uv.lock`, PHP without
 * `composer.lock`, `requirements.txt`: nothing (the right tool is not ours to guess).
 */
export function detectSetupCommand(dir: string, root: string = dir): SetupPlan | undefined {
  const pf = projectFile(dir);
  if (pf?.setup !== undefined)
    return pf.setup === false ? undefined : { command: pf.setup, cwd: '.' };
  const levels: string[] = [];
  let at = resolve(dir);
  const top = resolve(root);
  for (;;) {
    levels.push(at);
    if (at === top || dirname(at) === at || !at.startsWith(top)) break;
    at = dirname(at);
  }
  for (const level of levels) {
    const command = lockfileInstall(level, false);
    if (command) return { command, cwd: relative(dir, level) || '.' };
  }
  for (const level of levels) {
    const command = lockfileInstall(level, true);
    if (command) return { command, cwd: relative(dir, level) || '.' };
  }
  return undefined;
}

/**
 * The command that runs the project's own tests, from what the workspace contains; undefined
 * when nothing recognisable is there (the `tests` check then passes with a note).
 */
export function detectTestCommand(dir: string): string | undefined {
  const own = projectFile(dir)?.tests;
  if (own) return own;
  if (has(dir, 'package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.test) {
        if (has(dir, 'pnpm-lock.yaml')) return 'pnpm test';
        if (has(dir, 'yarn.lock')) return 'yarn test';
        if (has(dir, 'bun.lock') || has(dir, 'bun.lockb')) return 'bun test';
        return 'npm test';
      }
    } catch {
      // unreadable package.json: fall through to the other runners
    }
  }
  if (has(dir, 'pyproject.toml') || has(dir, 'pytest.ini') || has(dir, 'setup.py')) return 'pytest';
  if (has(dir, 'go.mod')) return 'go test ./...';
  if (has(dir, 'Cargo.toml')) return 'cargo test';
  if (has(dir, 'composer.json')) {
    if (has(dir, 'artisan')) return 'php artisan test';
    if (has(dir, 'phpunit.xml') || has(dir, 'phpunit.xml.dist')) return 'vendor/bin/phpunit';
  }
  if (has(dir, 'Gemfile') && has(dir, 'spec')) return 'bundle exec rspec';
  if (has(dir, 'Makefile')) {
    try {
      if (/^test\s*:/m.test(readFileSync(join(dir, 'Makefile'), 'utf8'))) return 'make test';
    } catch {
      // unreadable Makefile
    }
  }
  return undefined;
}

/** The package manager's `run` for a Node project, from its lockfile. */
function nodeRunner(dir: string): string {
  if (has(dir, 'pnpm-lock.yaml')) return 'pnpm run';
  if (has(dir, 'yarn.lock')) return 'yarn run';
  if (has(dir, 'bun.lock') || has(dir, 'bun.lockb')) return 'bun run';
  return 'npm run';
}

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

/**
 * The command that lints the project, from what the workspace contains: its own `lint`
 * script or make target first, then the linter it is configured for; undefined when there is
 * none (the `lint` check then passes with a note). Node tools run through `npx --no`: what
 * is installed, never a download (npm's "biome" is not Biome).
 */
export function detectLintCommand(dir: string): string | undefined {
  const own = projectFile(dir)?.lint;
  if (own) return own;
  if (has(dir, 'package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.lint) return `${nodeRunner(dir)} lint`;
    } catch {
      // unreadable package.json: fall through to the config files
    }
  }
  if (has(dir, 'Makefile')) {
    try {
      if (/^lint\s*:/m.test(readFileSync(join(dir, 'Makefile'), 'utf8'))) return 'make lint';
    } catch {
      // unreadable Makefile
    }
  }
  if (has(dir, 'biome.json') || has(dir, 'biome.jsonc')) return 'npx --no @biomejs/biome check .';
  if (has(dir, 'package.json') && ESLINT_CONFIGS.some((f) => has(dir, f)))
    return 'npx --no eslint .';
  if (has(dir, 'ruff.toml') || has(dir, '.ruff.toml')) return 'ruff check .';
  if (has(dir, 'pyproject.toml')) {
    try {
      if (/^\[tool\.ruff/m.test(readFileSync(join(dir, 'pyproject.toml'), 'utf8')))
        return 'ruff check .';
    } catch {
      // unreadable pyproject
    }
  }
  if (has(dir, 'phpstan.neon') || has(dir, 'phpstan.neon.dist'))
    return 'vendor/bin/phpstan analyse --no-progress';
  if (has(dir, 'go.mod'))
    return has(dir, '.golangci.yml') || has(dir, '.golangci.yaml')
      ? 'golangci-lint run'
      : 'go vet ./...';
  if (has(dir, 'Cargo.toml')) return 'cargo clippy --quiet -- -D warnings';
  return undefined;
}

export type Stack = 'node' | 'python' | 'php-laravel' | 'go';
export const STACKS: readonly Stack[] = ['node', 'python', 'php-laravel', 'go'];

/** The stack a project is written in, from its manifest; undefined when none is recognised. */
export function detectStack(dir: string): Stack | undefined {
  if (has(dir, 'package.json')) return 'node';
  if (has(dir, 'pyproject.toml') || has(dir, 'requirements.txt') || has(dir, 'setup.py'))
    return 'python';
  if (has(dir, 'composer.json') && has(dir, 'artisan')) return 'php-laravel';
  if (has(dir, 'go.mod')) return 'go';
  return undefined;
}

/**
 * The command that type-checks the project: `shibaox.yaml typecheck` first, then the checker
 * it is configured for (tsconfig → tsc, mypy/pyright config, go vet, phpstan); undefined
 * when there is none.
 */
export function detectTypecheckCommand(dir: string): string | undefined {
  const own = projectFile(dir)?.typecheck;
  if (own) return own;
  if (has(dir, 'package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      const script = ['typecheck', 'type-check', 'check-types', 'types'].find(
        (n) => pkg.scripts?.[n],
      );
      if (script) return `${nodeRunner(dir)} ${script}`;
    } catch {
      // unreadable package.json: fall through to tsconfig
    }
    if (has(dir, 'tsconfig.json')) {
      if (has(dir, 'pnpm-lock.yaml')) return 'pnpm exec tsc --noEmit';
      if (has(dir, 'yarn.lock')) return 'yarn tsc --noEmit';
      if (has(dir, 'bun.lock') || has(dir, 'bun.lockb')) return 'bunx tsc --noEmit';
      return 'npx --no tsc --noEmit';
    }
    return undefined;
  }
  const py = (cmd: string) => (has(dir, 'uv.lock') ? `uv run ${cmd}` : cmd);
  if (has(dir, 'mypy.ini') || has(dir, '.mypy.ini')) return py('mypy .');
  for (const [file, section] of [
    ['pyproject.toml', /^\[tool\.mypy\]/m],
    ['setup.cfg', /^\[mypy\]/m],
  ] as const)
    if (has(dir, file)) {
      try {
        if (section.test(readFileSync(join(dir, file), 'utf8'))) return py('mypy .');
      } catch {
        // unreadable config
      }
    }
  if (has(dir, 'pyrightconfig.json')) return py('pyright');
  if (has(dir, 'go.mod')) return 'go build ./...';
  if (has(dir, 'composer.json') && (has(dir, 'phpstan.neon') || has(dir, 'phpstan.neon.dist')))
    return 'vendor/bin/phpstan analyse --no-progress';
  return undefined;
}
