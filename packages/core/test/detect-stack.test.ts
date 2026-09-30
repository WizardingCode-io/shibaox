import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStack, detectTypecheckCommand } from '../src/gates/detect.js';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'stack-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), content);
  }
  return d;
}

describe('detectStack', () => {
  it('reads the stack off the manifest', () => {
    expect(detectStack(dir({ 'package.json': '{}' }))).toBe('node');
    expect(detectStack(dir({ 'pyproject.toml': '' }))).toBe('python');
    expect(detectStack(dir({ 'requirements.txt': '' }))).toBe('python');
    expect(detectStack(dir({ 'composer.json': '{}', artisan: '' }))).toBe('php-laravel');
    expect(detectStack(dir({ 'composer.json': '{}' }))).toBeUndefined(); // plain PHP has no template yet
    expect(detectStack(dir({ 'go.mod': 'module x' }))).toBe('go');
    expect(detectStack(dir({}))).toBeUndefined();
  });
});

describe('detectTypecheckCommand', () => {
  it('shibaox.yaml first, then the checker the project is configured for', () => {
    expect(detectTypecheckCommand(dir({ 'shibaox.yaml': 'typecheck: make types\n' }))).toBe(
      'make types',
    );
    expect(detectTypecheckCommand(dir({ 'package.json': '{}', 'tsconfig.json': '{}' }))).toBe(
      'npx --no tsc --noEmit',
    );
    expect(
      detectTypecheckCommand(
        dir({ 'package.json': '{}', 'tsconfig.json': '{}', 'pnpm-lock.yaml': '' }),
      ),
    ).toBe('pnpm exec tsc --noEmit');
    expect(detectTypecheckCommand(dir({ 'package.json': '{}' }))).toBeUndefined();
    expect(detectTypecheckCommand(dir({ 'pyproject.toml': '[tool.mypy]\n' }))).toBe('mypy .');
    expect(detectTypecheckCommand(dir({ 'mypy.ini': '' }))).toBe('mypy .');
    expect(detectTypecheckCommand(dir({ 'pyrightconfig.json': '{}' }))).toBe('pyright');
    expect(detectTypecheckCommand(dir({ 'pyproject.toml': '' }))).toBeUndefined();
    expect(detectTypecheckCommand(dir({ 'go.mod': 'module x' }))).toBe('go vet ./...');
    expect(detectTypecheckCommand(dir({ 'composer.json': '{}', 'phpstan.neon': '' }))).toBe(
      'vendor/bin/phpstan analyse --no-progress',
    );
    expect(detectTypecheckCommand(dir({ 'composer.json': '{}' }))).toBeUndefined();
  });
});
