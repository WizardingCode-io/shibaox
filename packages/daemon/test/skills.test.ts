import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrgEditError } from '../src/org-edit.js';
import { SkillsService, skillMeta } from '../src/skills.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mk(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(d);
  return d;
}

function org(): string {
  const dir = mk('skills-org-');
  scaffoldOrg(dir);
  return join(dir, 'org');
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    stdio: 'pipe',
  });

/** A bare repo (file:// URL) with the given files committed. */
function repo(files: Record<string, string>, links: Record<string, string> = {}): string {
  const work = mk('skills-work-');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    writeFileSync(join(work, rel), content);
  }
  for (const [rel, target] of Object.entries(links)) {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    symlinkSync(target, join(work, rel));
  }
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  const bare = join(mk('skills-bare-'), 'r.git');
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { stdio: 'pipe' });
  return `file://${bare}`;
}

const skill = (name: string, description: string, body = 'Do the thing.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

const service = () => new SkillsService({ env: process.env });

describe('skill metadata', () => {
  it('reads name and description from the frontmatter', () => {
    expect(skillMeta(skill('Pdf tools', 'Read PDFs'), 'pdf')).toEqual({
      name: 'Pdf tools',
      description: 'Read PDFs',
    });
  });
  it('falls back to the id and the first paragraph', () => {
    expect(skillMeta('# Title\n\nFirst   paragraph\nhere.\n\nSecond.', 'x')).toEqual({
      name: 'x',
      description: 'First paragraph here.',
    });
  });
});

describe('SkillsService', () => {
  it('lists the org skills with the roles that use them', () => {
    const root = org();
    const rows = service().list(root);
    expect(rows.map((r) => r.id)).toEqual(['higgsfield']);
    expect(rows[0]).toMatchObject({
      name: 'higgsfield',
      path: join(root, 'skills', 'higgsfield', 'SKILL.md'),
    });
    expect(rows[0]?.roles.length).toBeGreaterThan(0);
  });

  it('installs skills from a repository: every SKILL.md dir under path, exists skipped, ids filter', async () => {
    const root = org();
    const url = repo({
      'skills/pdf/SKILL.md': skill('pdf', 'PDF things'),
      'skills/pdf/scripts/run.py': 'print(1)\n',
      'skills/docx/SKILL.md': skill('docx', 'Word things'),
      'skills/higgsfield/SKILL.md': skill('hf', 'dup'),
      'README.md': '# repo\n',
    });
    const s = service();
    const r = await s.add(root, { source: 'repo', repo: url, path: 'skills' }, { local: true });
    expect(r.added.map((a) => a.id).sort()).toEqual(['docx', 'pdf']);
    expect(r.skipped).toEqual([{ id: 'higgsfield', reason: 'exists' }]);
    expect(readFileSync(join(root, 'skills/pdf/scripts/run.py'), 'utf8')).toBe('print(1)\n');
    expect(existsSync(join(root, 'skills/pdf/.git'))).toBe(false);
    // a second install with an ids filter: only what is asked, the rest untouched
    const root2 = org();
    const r2 = await s.add(
      root2,
      { source: 'repo', repo: url, ids: ['docx', 'nope'] },
      { local: true },
    );
    expect(r2.added.map((a) => a.id)).toEqual(['docx']);
    expect(r2.skipped).toEqual([{ id: 'nope', reason: 'not_found' }]);
    expect(existsSync(join(root2, 'skills/pdf'))).toBe(false);
  });

  it('never copies symlinks, files over 1 MB, nor a skill over 10 MB; invalid ids are skipped', async () => {
    const root = org();
    const url = repo(
      {
        'a/SKILL.md': skill('a', 'A'),
        'a/big.bin': 'x'.repeat(1_100_000),
        'b/SKILL.md': skill('b', 'B'),
        ...Object.fromEntries(
          Array.from({ length: 11 }, (_, i) => [`b/part${i}.bin`, 'y'.repeat(1_000_000)]),
        ),
        'bad.name/SKILL.md': skill('bad', 'Bad'),
      },
      { 'a/passwd': '/etc/passwd', 'c/SKILL.md': '/etc/hosts' },
    );
    const r = await service().add(root, { source: 'repo', repo: url }, { local: true });
    expect(r.added.map((a) => a.id)).toEqual(['a']);
    expect(readdirSync(join(root, 'skills/a')).sort()).toEqual(['SKILL.md']);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { id: 'b', reason: 'too_large' },
        { id: 'bad.name', reason: 'invalid_id' },
      ]),
    );
    expect(existsSync(join(root, 'skills/c'))).toBe(false);
    expect(existsSync(join(root, 'skills/b'))).toBe(false);
  });

  it('refuses repository forms other than owner/repo and https for a network caller', async () => {
    const root = org();
    await expect(
      service().add(root, { source: 'repo', repo: 'file:///etc' }, { local: false }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service().add(root, { source: 'repo', repo: '--upload-pack=x' }, { local: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service().add(root, { source: 'repo', repo: url0(), path: '../x' }, { local: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('installs from a folder (local only) and inline', async () => {
    const root = org();
    const folder = mk('skills-folder-');
    mkdirSync(join(folder, 'mine'));
    writeFileSync(join(folder, 'mine', 'SKILL.md'), skill('Mine', 'My skill'));
    const s = service();
    await expect(
      s.add(root, { source: 'folder', path: join(folder, 'mine') }, { local: false }),
    ).rejects.toMatchObject({ status: 403 });
    const r = await s.add(root, { source: 'folder', path: join(folder, 'mine') }, { local: true });
    expect(r.added).toMatchObject([{ id: 'mine', name: 'Mine', description: 'My skill' }]);
    const i = await s.add(
      root,
      { source: 'inline', id: 'notes', content: skill('Notes', 'Take notes') },
      { local: false },
    );
    expect(i.added[0]?.id).toBe('notes');
    const again = await s.add(
      root,
      { source: 'inline', id: 'notes', content: 'x' },
      { local: false },
    );
    expect(again.skipped).toEqual([{ id: 'notes', reason: 'exists' }]);
    await expect(
      s.add(root, { source: 'inline', id: '../evil', content: 'x' }, { local: true }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('discovers a repository once per 10 minutes (cached clone listing)', async () => {
    let clones = 0;
    let now = 0;
    const s = new SkillsService({
      env: process.env,
      now: () => now,
      onClone: () => {
        clones++;
      },
    });
    const url = repo({ 'x/SKILL.md': skill('X', 'Ex'), 'y/SKILL.md': '# Y\n\nWhy.\n' });
    const d = await s.discover(url, undefined, { local: true });
    expect(d.repo).toBe(url);
    expect(d.skills).toEqual([
      { id: 'x', name: 'X', description: 'Ex', path: 'x' },
      { id: 'y', name: 'y', description: 'Why.', path: 'y' },
    ]);
    await s.discover(url, undefined, { local: true });
    expect(clones).toBe(1);
    now += 11 * 60_000;
    await s.discover(url, undefined, { local: true });
    expect(clones).toBe(2);
  });

  it('removes a skill: 409 with the roles while used, detach first when asked', async () => {
    const root = org();
    const s = service();
    let err: unknown;
    try {
      s.remove(root, 'higgsfield', { detach: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(OrgEditError);
    expect((err as OrgEditError).status).toBe(409);
    const roles = ((err as OrgEditError).details as { roles: string[] }).roles;
    expect(roles.length).toBeGreaterThan(0);
    const before = readFileSync(join(root, 'roles', `${roles[0]}.yaml`), 'utf8');
    expect(s.remove(root, 'higgsfield', { detach: true })).toEqual({ removed: true });
    expect(existsSync(join(root, 'skills/higgsfield'))).toBe(false);
    const after = readFileSync(join(root, 'roles', `${roles[0]}.yaml`), 'utf8');
    expect(after).not.toMatch(/skills: \[higgsfield\]/);
    // comments of the role file survive
    expect(after).toContain('# Higgsfield');
    expect(before).toContain('# Higgsfield');
    expect(() => s.remove(root, 'higgsfield', { detach: true })).toThrow(/not found/);
  });
});

function url0(): string {
  return repo({ 'a/SKILL.md': skill('a', 'A') });
}
