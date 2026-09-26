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
});
