import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileProject, renderProfileNote } from '../src/index.js';

const dir = () => mkdtempSync(join(tmpdir(), 'prof-'));
const file = (root: string, rel: string, content = 'x') => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
};

describe('profileProject', () => {
  it('reads a Node project: stack, package manager, test command, size and languages', () => {
    const d = dir();
    file(
      d,
      'package.json',
      JSON.stringify({
        name: 'shop',
        dependencies: { next: '1', react: '1' },
        scripts: { test: 'vitest' },
      }),
    );
    file(d, 'pnpm-lock.yaml');
    file(d, 'src/a.ts');
    file(d, 'src/b.tsx');
    file(d, 'node_modules/x/index.js');
    const p = profileProject(d);
    expect(p.name).toBe('shop');
    expect(p.stack).toEqual(['Next.js', 'React', 'TypeScript']);
    expect(p.packageManager).toBe('pnpm');
    expect(p.testCommand).toBe('pnpm test');
    expect(p.files).toBe(4);
    expect(p.git).toBe(false);
    expect(p.languages[0]).toEqual({ ext: 'ts', files: 1 });
    expect(p.summary).toBe('Next.js · React · TypeScript · pnpm test · 4 files');
  });
  it('recognises the other marker files', () => {
    const cases: [string, string, string[]][] = [
      [
        'composer.json',
        JSON.stringify({ require: { 'laravel/framework': '^11' } }),
        ['Laravel', 'PHP'],
      ],
      ['go.mod', 'module x', ['Go']],
      ['Cargo.toml', '[package]', ['Rust']],
      ['pubspec.yaml', 'dependencies:\n  flutter:\n    sdk: flutter\n', ['Flutter', 'Dart']],
      ['project.godot', '', ['Godot']],
      ['manage.py', '', ['Django', 'Python']],
      ['Gemfile', "gem 'rails'", ['Rails', 'Ruby']],
    ];
    for (const [name, content, stack] of cases) {
      const d = dir();
      file(d, name, content);
      expect(profileProject(d).stack, name).toEqual(stack);
    }
  });
  it('an empty directory has no stack and says so', () => {
    const p = profileProject(dir());
    expect(p.stack).toEqual([]);
    expect(p.files).toBe(0);
    expect(p.summary).toBe('empty directory');
  });
  it('stops at maxFiles and never follows symlinked directories', () => {
    const d = dir();
    for (let i = 0; i < 10; i++) file(d, `f${i}.js`);
    const outside = dir();
    file(outside, 'secret.txt');
    symlinkSync(outside, join(d, 'link'));
    const p = profileProject(d, { maxFiles: 3 });
    expect(p.files).toBe(3);
    expect(p.truncated).toBe(true);
    expect(p.summary).toContain('3+ files');
    const full = profileProject(d);
    expect(full.files).toBe(10);
  });
  it('reads the git branch from .git/HEAD (a detached head shows the short sha)', () => {
    const d = dir();
    file(d, '.git/HEAD', 'ref: refs/heads/feat/x\n');
    const p = profileProject(d);
    expect(p.git).toBe(true);
    expect(p.branch).toBe('feat/x');
    const detached = dir();
    file(detached, '.git/HEAD', 'abcdef0123456789abcdef0123456789abcdef01\n');
    expect(profileProject(detached).branch).toBe('abcdef0');
    expect(profileProject(dir()).branch).toBeUndefined();
  });
  it('renders a note with frontmatter', () => {
    const d = dir();
    file(d, 'go.mod', 'module x');
    const note = renderProfileNote(profileProject(d));
    expect(note.startsWith('---\ntype: project-profile\n')).toBe(true);
    expect(note).toContain('Go');
  });
});
