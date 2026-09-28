import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const has = (dir: string, file: string) => existsSync(join(dir, file));

/**
 * The command that runs the project's own tests, from what the workspace contains; undefined
 * when nothing recognisable is there (the `tests` check then passes with a note).
 */
export function detectTestCommand(dir: string): string | undefined {
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
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

/**
 * The command that lints the project, from what the workspace contains: its own `lint`
 * script first, then the linter it is configured for; undefined when there is none (the
 * `lint` check then passes with a note).
 */
export function detectLintCommand(dir: string): string | undefined {
  if (has(dir, 'package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.lint) return `${nodeRunner(dir)} lint`;
    } catch {
      // unreadable package.json: fall through to the config files
    }
    if (has(dir, 'biome.json') || has(dir, 'biome.jsonc')) return 'npx biome check .';
    if (ESLINT_CONFIGS.some((f) => has(dir, f))) return 'npx eslint .';
  }
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
  if (has(dir, 'Makefile')) {
    try {
      if (/^lint\s*:/m.test(readFileSync(join(dir, 'Makefile'), 'utf8'))) return 'make lint';
    } catch {
      // unreadable Makefile
    }
  }
  return undefined;
}
