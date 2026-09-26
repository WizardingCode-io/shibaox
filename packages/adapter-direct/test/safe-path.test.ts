import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safePath } from '../src/index.js';

describe('safePath', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  it('accepts relative paths inside the workspace', () => {
    expect(safePath(ws, 'src/a.ts')).toBe(join(ws, 'src/a.ts'));
  });
  it('rejects ../ escapes and absolute paths outside', () => {
    expect(() => safePath(ws, '../etc/passwd')).toThrow(/escapes workspace/);
    expect(() => safePath(ws, '/etc/passwd')).toThrow(/escapes workspace/);
  });
  it('rejects a symlink pointing outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'secret'), 'x');
    mkdirSync(join(ws, 'links'), { recursive: true });
    symlinkSync(outside, join(ws, 'links/out'));
    expect(() => safePath(ws, 'links/out/secret')).toThrow(/escapes workspace/);
  });
  it('write mode refuses any .git segment (case-insensitive), including via a symlink', () => {
    const w = mkdtempSync(join(tmpdir(), 'ws-'));
    mkdirSync(join(w, '.git'));
    expect(() => safePath(w, '.git/config', { write: true })).toThrow(
      'path ".git/config" targets .git',
    );
    expect(() => safePath(w, 'sub/.GIT/hooks/x', { write: true })).toThrow(/targets \.git/);
    symlinkSync(join(w, '.git'), join(w, 'g'));
    expect(() => safePath(w, 'g/config', { write: true })).toThrow(/targets \.git/);
    expect(safePath(w, '.gitignore', { write: true })).toBe(join(w, '.gitignore'));
    expect(safePath(w, 'a/.github/x.yml', { write: true })).toBe(join(w, 'a/.github/x.yml'));
    // read mode is unchanged
    expect(safePath(w, '.git/config')).toBe(join(w, '.git/config'));
  });
});
