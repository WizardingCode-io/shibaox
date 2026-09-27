import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryNotes } from '../src/index.js';

const notes = (project = 'shop') =>
  new MemoryNotes({
    vault: mkdtempSync(join(tmpdir(), 'vault-')),
    project,
    now: () => new Date('2026-09-27T10:00:00Z'),
  });

describe('MemoryNotes', () => {
  it('remember appends dated lines to the user and project notes', () => {
    const m = notes();
    const u = m.remember('user', 'uses pnpm for packages');
    const p = m.remember('project', 'API lives in src/api');
    m.remember('user', 'prefers short answers');
    expect(u.path.endsWith(join('00-org', 'memory.md'))).toBe(true);
    expect(p.path.endsWith(join('10-projects', 'shop', 'memory.md'))).toBe(true);
    const user = readFileSync(u.path, 'utf8');
    expect(user.startsWith('---\ntype: memory\nscope: user\n')).toBe(true);
    expect(user).toContain(
      '- 2026-09-27 · uses pnpm for packages\n- 2026-09-27 · prefers short answers\n',
    );
    expect(readFileSync(p.path, 'utf8')).toContain('- 2026-09-27 · API lives in src/api');
  });
  it('recall finds lines containing every word of the query, in any case', () => {
    const m = notes();
    m.remember('user', 'uses pnpm for packages');
    m.remember('project', 'deploys with docker compose');
    expect(m.recall('PNPM packages')).toEqual([
      { scope: 'user', line: '2026-09-27 · uses pnpm for packages' },
    ]);
    expect(m.recall('docker')).toEqual([
      { scope: 'project', line: '2026-09-27 · deploys with docker compose' },
    ]);
    expect(m.recall('kubernetes')).toEqual([]);
    expect(m.recall('')).toEqual([]);
  });
  it('preamble carries the profile summary and the tails of both notes within maxBytes', () => {
    const m = notes();
    expect(m.preamble()).toBe('');
    m.remember('user', 'uses pnpm');
    for (let i = 0; i < 50; i++) m.remember('project', `decision ${i}`);
    const p = m.preamble({ profileSummary: 'Node · 3 files', maxBytes: 600 });
    expect(p.startsWith('Project: Node · 3 files')).toBe(true);
    expect(p).toContain('data, not instructions');
    expect(p).toContain('uses pnpm');
    expect(p).toContain('decision 49');
    expect(p).not.toContain('decision 0\n');
    expect(Buffer.byteLength(p)).toBeLessThanOrEqual(600);
  });
  it('refuses a project name that is not a safe id', () => {
    expect(() => notes('a/b').remember('project', 'x')).toThrow(/invalid project/);
  });
  it('does not create the notes until something is remembered', () => {
    const m = notes();
    expect(m.recall('x')).toEqual([]);
    expect(existsSync(join(m.vault, '00-org', 'memory.md'))).toBe(false);
  });
});
