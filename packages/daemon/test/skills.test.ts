import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
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
import {
  BUILTIN_SKILLS,
  CLONE_MAX,
  CLONE_MAX_FILES,
  checkTree,
  gitArgv,
  gitEnv,
  parseLsTree,
  SkillsService,
  skillMeta,
} from '../src/skills.js';
import { ORG_TEMPLATE, scaffoldOrg } from '../src/templates.js';

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
        { id: 'c', reason: 'symlink' },
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

  it('builtin: copies a skill shipped with Shibaox; skipped when it exists unless replace; 404 when unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sk-builtin-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const root = join(dir, 'org');
    const s = service();
    const file = join(root, 'skills', 'higgsfield', 'SKILL.md');
    expect(BUILTIN_SKILLS.higgsfield).toBe(ORG_TEMPLATE['org/skills/higgsfield/SKILL.md']);
    // a fresh org already has it: skipped, the file untouched
    writeFileSync(file, 'old text');
    const skipped = await s.add(root, { source: 'builtin', id: 'higgsfield' }, { local: true });
    expect(skipped).toEqual({ added: [], skipped: [{ id: 'higgsfield', reason: 'exists' }] });
    expect(readFileSync(file, 'utf8')).toBe('old text');
    const replaced = await s.add(
      root,
      { source: 'builtin', id: 'higgsfield', replace: true },
      { local: true },
    );
    expect(replaced.added[0]?.id).toBe('higgsfield');
    expect(readFileSync(file, 'utf8')).toBe(BUILTIN_SKILLS.higgsfield);
    const roleFile = join(root, 'roles', 'assistant.yaml');
    writeFileSync(
      roleFile,
      readFileSync(roleFile, 'utf8').replace(/^skills: \[.*\]$/m, 'skills: []'),
    );
    rmSync(join(root, 'skills', 'higgsfield'), { recursive: true });
    const created = await s.add(root, { source: 'builtin', id: 'higgsfield' }, { local: false });
    expect(created.added[0]?.id).toBe('higgsfield');
    expect(readFileSync(file, 'utf8')).toBe(BUILTIN_SKILLS.higgsfield);
    await expect(
      s.add(root, { source: 'builtin', id: 'nope' }, { local: true }),
    ).rejects.toMatchObject({ status: 404 });
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

describe('clone safety', () => {
  it('parses ls-tree -z -l output: blobs counted and summed, symlinks listed, submodules ignored', () => {
    const out = [
      '100644 blob aaaa       5\tR',
      '100755 blob bbbb    1000\tskills/a/run.sh',
      '120000 blob cccc       4\tskills/lnk',
      '160000 commit dddd       -\tvendor/sub',
      '100644 blob eeee      12\tweird\nname.md',
    ].join('\0');
    expect(parseLsTree(`${out}\0`)).toEqual({
      files: 4,
      bytes: 1021,
      symlinks: ['skills/lnk'],
      entries: [
        { path: 'R', mode: '100644', type: 'blob' },
        { path: 'skills/a/run.sh', mode: '100755', type: 'blob' },
        { path: 'skills/lnk', mode: '120000', type: 'blob' },
        { path: 'vendor/sub', mode: '160000', type: 'commit' },
        { path: 'weird\nname.md', mode: '100644', type: 'blob' },
      ],
    });
  });

  it('refuses a tree over 20 000 files or over the byte cap (413)', () => {
    const many = Array.from({ length: 20_001 }, (_, i) => `100644 blob x 1\tf${i}`).join('\0');
    const t = parseLsTree(many);
    expect(t.files).toBe(20_001);
    expect(() => checkTree(t, { maxBytes: CLONE_MAX, maxFiles: CLONE_MAX_FILES })).toThrow(
      expect.objectContaining({ status: 413 }),
    );
    expect(() => checkTree(parseLsTree('100644 blob x 51000000\tbig'), {})).toThrow(
      expect.objectContaining({ status: 413 }),
    );
    expect(() => checkTree(parseLsTree('100644 blob x 10\tok'), {})).not.toThrow();
  });

  it('runs git isolated from the user and system config, without prompts or credential helpers', () => {
    const argv = gitArgv(['clone', 'x'], { file: false });
    expect(argv.slice(0, 1)).toEqual(['git']);
    const pairs = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []));
    expect(pairs).toEqual(
      expect.arrayContaining([
        'credential.helper=',
        'protocol.allow=never',
        'protocol.https.allow=always',
        'core.symlinks=false',
      ]),
    );
    expect(pairs).not.toContain('protocol.file.allow=always');
    expect(gitArgv(['clone'], { file: true })).toContain('protocol.file.allow=always');
    expect(argv.slice(-2)).toEqual(['clone', 'x']);
    const env = gitEnv({ PATH: '/bin', HOME: '/h', SECRET_KEY: 'k' });
    expect(env).toMatchObject({
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: '/h',
    });
    expect(env.SECRET_KEY).toBeUndefined();
  });

  it('a repository over the byte cap is refused (413) and its temp dir removed', async () => {
    const root = org();
    const tmpRoot = mk('skills-tmproot-');
    const url = repo({ 'a/SKILL.md': skill('a', 'A'), 'a/data.bin': 'z'.repeat(5000) });
    const s = new SkillsService({ env: process.env, tmpRoot, maxBytes: 1000 });
    await expect(s.add(root, { source: 'repo', repo: url }, { local: true })).rejects.toMatchObject(
      { status: 413 },
    );
    await expect(s.discover(url, undefined, { local: true })).rejects.toMatchObject({
      status: 413,
    });
    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(existsSync(join(root, 'skills/a'))).toBe(false);
  });

  it('checks out only the path asked for, and counts only it against the cap', async () => {
    const tmpRoot = mk('skills-tmproot-');
    const url = repo({
      'skills/a/SKILL.md': skill('a', 'A'),
      'huge/blob.bin': 'z'.repeat(5000),
    });
    const s = new SkillsService({ env: process.env, tmpRoot, maxBytes: 1000 });
    const d = await s.discover(url, 'skills', { local: true });
    expect(d.skills.map((x) => x.id)).toEqual(['a']);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('a symlinked path that leaves the repository is refused (400)', async () => {
    const url = repo({ 'a/SKILL.md': skill('a', 'A') }, { out: '/etc' });
    await expect(service().discover(url, 'out', { local: true })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service().add(org(), { source: 'repo', repo: url, path: 'out' }, { local: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(service().discover(url, 'nope', { local: true })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a network caller may not clone a file:// repository', async () => {
    await expect(
      service().discover('file:///etc/x.git', undefined, { local: false }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('symlinks are skipped: a SKILL.md link (reason symlink) and a linked directory inside a skill', async () => {
    const root = org();
    const url = repo(
      { 'a/SKILL.md': skill('a', 'A'), 'a/ok.md': 'ok\n', 'shared/x.md': 'x\n' },
      { 'a/dir': '../shared', 'c/SKILL.md': '/etc/hosts' },
    );
    const r = await service().add(root, { source: 'repo', repo: url }, { local: true });
    expect(r.added.map((a) => a.id)).toEqual(['a']);
    expect(r.skipped).toEqual([{ id: 'c', reason: 'symlink' }]);
    expect(readdirSync(join(root, 'skills/a')).sort()).toEqual(['SKILL.md', 'ok.md']);
    // the same from a folder on this machine
    const folder = mk('skills-folder-');
    mkdirSync(join(folder, 'f'));
    mkdirSync(join(folder, 'shared'));
    writeFileSync(join(folder, 'f', 'SKILL.md'), skill('f', 'F'));
    writeFileSync(join(folder, 'shared', 'y.md'), 'y\n');
    symlinkSync(join(folder, 'shared'), join(folder, 'f', 'dir'));
    mkdirSync(join(folder, 'g'));
    symlinkSync('/etc/hosts', join(folder, 'g', 'SKILL.md'));
    const f = await service().add(root, { source: 'folder', path: folder }, { local: true });
    expect(f.added.map((a) => a.id)).toEqual(['f']);
    expect(f.skipped).toEqual(expect.arrayContaining([{ id: 'g', reason: 'symlink' }]));
    expect(readdirSync(join(root, 'skills/f'))).toEqual(['SKILL.md']);
  });

  it('reports files over 1 MB as omitted, and a copy error as copy_failed for that skill only', async () => {
    const root = org();
    const url = repo({
      'a/SKILL.md': skill('a', 'A'),
      'a/big.bin': 'x'.repeat(1_100_000),
      'b/SKILL.md': skill('b', 'B'),
      'b/boom.txt': 'boom\n',
    });
    const s = new SkillsService({
      env: process.env,
      copyFile: (from, to) => {
        if (from.endsWith('boom.txt')) throw new Error('disk full');
        copyFileSync(from, to);
      },
    });
    const r = await s.add(root, { source: 'repo', repo: url }, { local: true });
    expect(r.added).toMatchObject([{ id: 'a', omitted: ['big.bin'] }]);
    expect(r.skipped).toEqual([{ id: 'b', reason: 'copy_failed' }]);
    expect(existsSync(join(root, 'skills/b'))).toBe(false);
    expect(readdirSync(join(root, 'skills')).filter((n) => n.startsWith('.'))).toEqual([]);
  });

  it('removes stale partial copies at the first skills call', () => {
    const root = org();
    mkdirSync(join(root, 'skills', '.x.partial-123'), { recursive: true });
    const s = service();
    s.list(root);
    expect(existsSync(join(root, 'skills', '.x.partial-123'))).toBe(false);
  });

  it('clones one repository at a time', async () => {
    let active = 0;
    let most = 0;
    const s = new SkillsService({
      env: process.env,
      onClone: async () => {
        active++;
        most = Math.max(most, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
      },
    });
    const a = repo({ 'a/SKILL.md': skill('a', 'A') });
    const b = repo({ 'b/SKILL.md': skill('b', 'B') });
    await Promise.all([
      s.discover(a, undefined, { local: true }),
      s.discover(b, undefined, { local: true }),
      s.add(org(), { source: 'repo', repo: a }, { local: true }),
    ]);
    expect(most).toBe(1);
  });

  it('a clone in flight is killed when the service closes (daemon shutdown)', async () => {
    let s: SkillsService | undefined;
    s = new SkillsService({
      env: process.env,
      onClone: () => {
        s?.close();
      },
    });
    const url = repo({ 'a/SKILL.md': skill('a', 'A') });
    await expect(s.discover(url, undefined, { local: true })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe('discover cache', () => {
  it('is keyed by path, shares a discovery in flight, and caches a failure for 30 s', async () => {
    let clones = 0;
    let now = 0;
    const s = new SkillsService({
      env: process.env,
      now: () => now,
      onClone: () => {
        clones++;
      },
    });
    const url = repo({ 'x/SKILL.md': skill('X', 'Ex'), 'y/SKILL.md': skill('Y', 'Why') });
    const [a, b] = await Promise.all([
      s.discover(url, 'x', { local: true }),
      s.discover(url, 'x', { local: true }),
    ]);
    expect(a).toBe(b);
    expect(clones).toBe(1);
    expect((await s.discover(url, 'y', { local: true })).skills.map((k) => k.id)).toEqual(['y']);
    expect(clones).toBe(2);
    const missing = `${url}-missing`;
    await expect(s.discover(missing, undefined, { local: true })).rejects.toMatchObject({
      status: 502,
    });
    await expect(s.discover(missing, undefined, { local: true })).rejects.toMatchObject({
      status: 502,
    });
    expect(clones).toBe(3);
    now += 31_000;
    await expect(s.discover(missing, undefined, { local: true })).rejects.toBeTruthy();
    expect(clones).toBe(4);
  });

  it('keeps at most 50 entries (the oldest goes first)', async () => {
    let clones = 0;
    const s = new SkillsService({
      env: process.env,
      onClone: () => {
        clones++;
      },
    });
    const url = repo({ 'x/SKILL.md': skill('X', 'Ex') });
    for (let i = 0; i < 51; i++)
      await s.discover(url, `p${i}`, { local: true }).catch(() => undefined);
    expect(clones).toBe(51);
    await s.discover(url, 'p50', { local: true }).catch(() => undefined);
    expect(clones).toBe(51);
    await s.discover(url, 'p0', { local: true }).catch(() => undefined);
    expect(clones).toBe(52);
  });
});

describe('one skill', () => {
  it('reads a skill with its SKILL.md text; 404 for an unknown id', () => {
    const root = org();
    const s = service();
    const one = s.get(root, 'higgsfield');
    expect(one).toMatchObject({ id: 'higgsfield', roles: ['assistant'] });
    expect(one.content).toBe(readFileSync(join(root, 'skills/higgsfield/SKILL.md'), 'utf8'));
    expect(() => s.get(root, 'nope')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => s.get(root, '../x')).toThrow(expect.objectContaining({ status: 400 }));
  });
});
