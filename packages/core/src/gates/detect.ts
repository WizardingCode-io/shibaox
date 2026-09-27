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
