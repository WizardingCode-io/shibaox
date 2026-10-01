import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { bearerEnv } from '@wizardingcode/shibaox-core';
import { Id, loadOrg } from '@wizardingcode/shibaox-schemas';
import { parse as parseYaml } from 'yaml';
import { detachFromRoles, OrgEditError } from './org-edit.js';

/** One skill of an org (`skills/<id>/SKILL.md`), with the roles that list it. */
export interface SkillRow {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
  roles: string[];
}

/** Where skills come from: a git repository, a folder on the daemon's machine, or text. */
export type SkillAddRequest =
  | { source: 'repo'; repo: string; path?: string; ids?: string[] }
  | { source: 'folder'; path: string }
  | { source: 'inline'; id: string; content: string };

export interface SkillAddResult {
  added: SkillRow[];
  skipped: { id: string; reason: SkipReason }[];
}
export type SkipReason = 'exists' | 'invalid_id' | 'symlink' | 'too_large' | 'not_found';

/** A skill found in a repository (`path` is its directory, relative to the repository). */
export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  path: string;
}
export interface SkillDiscovery {
  repo: string;
  skills: DiscoveredSkill[];
}

export const SKILL_FILE_MAX = 1_000_000;
export const SKILL_TOTAL_MAX = 10_000_000;
export const CLONE_MAX = 50_000_000;
export const CLONE_TIMEOUT_MS = 60_000;
const DISCOVER_TTL_MS = 10 * 60_000;
const MAX_DEPTH = 6;

/** `name` and `description` of a SKILL.md: its frontmatter, else the id and the first paragraph. */
export function skillMeta(text: string, id: string): { name: string; description: string } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  let meta: Record<string, unknown> = {};
  if (fm) {
    try {
      const parsed = parseYaml(fm[1] ?? '');
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      // a broken frontmatter reads as none
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const para =
    body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#') && !p.startsWith('```')) ?? '';
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    name: str(meta.name) ?? id,
    description: (str(meta.description) ?? para.replace(/\s+/g, ' ')).slice(0, 300),
  };
}

const isRegularFile = (p: string) => {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/** Directories holding a SKILL.md under `base` (never through a symlink, never inside `.git`). */
function findSkillDirs(base: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, 'SKILL.md'))) {
      out.push(dir);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const p = join(dir, name);
      if (lstatSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

/** The regular files of a skill directory (relative paths) within the caps; symlinks never. */
function skillFiles(dir: string): { files: string[] } | { reason: SkipReason } {
  const skillMd = join(dir, 'SKILL.md');
  if (lstatSync(skillMd).isSymbolicLink()) return { reason: 'symlink' };
  if (!isRegularFile(skillMd) || lstatSync(skillMd).size > SKILL_FILE_MAX)
    return { reason: 'too_large' };
  const files: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size <= SKILL_FILE_MAX) {
        total += st.size;
        files.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  if (total > SKILL_TOTAL_MAX) return { reason: 'too_large' };
  return { files };
}

function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const st = lstatSync(join(d, n));
        if (st.isDirectory()) stack.push(join(d, n));
        else total += st.size;
      } catch {
        // gone while counting
      }
    }
  }
  return total;
}

/** The URL git clones for `repo`: `owner/repo` (GitHub), an https URL, or (local callers) a file URL or path. */
export function repoUrl(repo: string, local: boolean): string {
  const r = repo.trim();
  if (/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(r))
    return `https://github.com/${r.replace(/\.git$/, '')}.git`;
  if (/^https:\/\/[^\s@]+$/.test(r)) return r;
  if (local && (/^file:\/\/\/\S+$/.test(r) || (isAbsolute(r) && !r.startsWith('-')))) return r;
  throw new OrgEditError(
    400,
    'bad_request',
    `"repo" must be owner/repo or an https git URL (got "${repo}")`,
  );
}

/** A relative path inside a repository (no `..`, not absolute). */
function subPath(path: string | undefined): string {
  const p = (path ?? '')
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!p) return '';
  if (isAbsolute(p) || p.split(/[\\/]/).some((s) => s === '..' || s.startsWith('-')))
    throw new OrgEditError(400, 'bad_request', `"path" must be relative to the repository root`);
  return p;
}

export interface SkillsServiceOptions {
  /** The daemon's environment: git gets PATH (augmented), HOME and the locale only. */
  env: NodeJS.ProcessEnv;
  now?: () => number;
  /** Called on every clone (tests count them). */
  onClone?: (url: string) => void;
  log?: (line: string) => void;
}

/** The org's skills: listing, installing (repository, folder, text), discovery and removal. */
export class SkillsService {
  private readonly cache = new Map<string, { at: number; value: SkillDiscovery }>();
  constructor(private readonly o: SkillsServiceOptions) {}

  list(root: string): SkillRow[] {
    const org = loadOrg(root);
    const dir = join(root, 'skills');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((id) => Id.safeParse(id).success && isRegularFile(join(dir, id, 'SKILL.md')))
      .sort()
      .map((id) => this.row(root, id, org));
  }

  private row(root: string, id: string, org = loadOrg(root)): SkillRow {
    const path = join(root, 'skills', id, 'SKILL.md');
    return {
      id,
      ...skillMeta(readFileSync(path, 'utf8'), id),
      path,
      roles: Object.values(org.roles)
        .filter((r) => r.skills.includes(id))
        .map((r) => r.role)
        .sort(),
    };
  }

  /** Clones `url` (depth 1, no submodules) into a temp dir, runs `use`, and removes the dir. */
  private async withClone<T>(url: string, use: (dir: string) => T | Promise<T>): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), 'shibaox-skills-'));
    try {
      const dest = join(tmp, 'repo');
      this.o.onClone?.(url);
      await cloneShallow(url, dest, bearerEnv(this.o.env));
      return await use(dest);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async discover(
    repo: string,
    path: string | undefined,
    o: { local: boolean },
  ): Promise<SkillDiscovery> {
    const url = repoUrl(repo, o.local);
    const sub = subPath(path);
    const key = `${url}#${sub}`;
    const now = (this.o.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < DISCOVER_TTL_MS) return hit.value;
    const value = await this.withClone(url, (dir) => {
      const base = inside(dir, sub);
      return {
        repo,
        skills: findSkillDirs(base).map((d) => {
          const id = d === dir ? repoName(url) : basename(d);
          const md = join(d, 'SKILL.md');
          const text = isRegularFile(md) ? readFileSync(md, 'utf8').slice(0, SKILL_FILE_MAX) : '';
          return { id, ...skillMeta(text, id), path: relative(dir, d) || '.' };
        }),
      };
    });
    this.cache.set(key, { at: now, value });
    return value;
  }

  async add(root: string, req: SkillAddRequest, o: { local: boolean }): Promise<SkillAddResult> {
    loadOrg(root); // an org that does not load is not edited
    if (req?.source === 'inline') return this.addInline(root, req);
    if (req?.source === 'folder') {
      if (!o.local)
        throw new OrgEditError(
          403,
          'forbidden',
          "a folder is copied from the daemon's own machine only",
        );
      if (typeof req.path !== 'string' || !isAbsolute(req.path))
        throw new OrgEditError(400, 'bad_request', '"path" must be an absolute folder path');
      if (!existsSync(req.path) || !lstatSync(req.path).isDirectory())
        throw new OrgEditError(404, 'not_found', `folder ${req.path} not found`);
      const base = realpathSync(req.path);
      return this.install(root, findSkillDirs(base), (d) => basename(d));
    }
    if (req?.source === 'repo') {
      if (typeof req.repo !== 'string' || !req.repo.trim())
        throw new OrgEditError(400, 'bad_request', '"repo" is required');
      if (
        req.ids !== undefined &&
        !(Array.isArray(req.ids) && req.ids.every((i) => typeof i === 'string'))
      )
        throw new OrgEditError(400, 'bad_request', '"ids" is a list of skill ids');
      const url = repoUrl(req.repo, o.local);
      const sub = subPath(req.path);
      return this.withClone(url, (dir) =>
        this.install(
          root,
          findSkillDirs(inside(dir, sub)),
          (d) => (d === dir ? repoName(url) : basename(d)),
          req.ids,
        ),
      );
    }
    throw new OrgEditError(400, 'bad_request', '"source" takes repo, folder or inline');
  }

  private addInline(root: string, req: { id: string; content: string }): SkillAddResult {
    if (typeof req.id !== 'string' || !Id.safeParse(req.id).success)
      throw new OrgEditError(
        400,
        'bad_request',
        `"id" must use letters, digits, - _ (got "${req.id}")`,
      );
    if (typeof req.content !== 'string' || !req.content.trim())
      throw new OrgEditError(400, 'bad_request', '"content" (the SKILL.md text) is required');
    if (Buffer.byteLength(req.content) > SKILL_FILE_MAX)
      throw new OrgEditError(413, 'too_large', 'a SKILL.md is at most 1 MB');
    const dest = join(root, 'skills', req.id);
    if (existsSync(dest)) return { added: [], skipped: [{ id: req.id, reason: 'exists' }] };
    const partial = join(root, 'skills', `.${req.id}.partial-${process.pid}`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, 'SKILL.md'), req.content);
    renameSync(partial, dest);
    return { added: [this.row(root, req.id)], skipped: [] };
  }

  private install(
    root: string,
    dirs: string[],
    idFor: (dir: string) => string,
    ids?: string[],
  ): SkillAddResult {
    const result: SkillAddResult = { added: [], skipped: [] };
    const seen = new Set<string>();
    const skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    for (const dir of dirs) {
      const id = idFor(dir);
      if (ids && !ids.includes(id)) continue;
      seen.add(id);
      if (!Id.safeParse(id).success) {
        result.skipped.push({ id, reason: 'invalid_id' });
        continue;
      }
      const dest = join(skillsDir, id);
      if (existsSync(dest)) {
        result.skipped.push({ id, reason: 'exists' });
        continue;
      }
      const listed = skillFiles(dir);
      if ('reason' in listed) {
        result.skipped.push({ id, reason: listed.reason });
        continue;
      }
      // copied aside, then renamed in one step: a run never sees half a skill
      const partial = join(skillsDir, `.${id}.partial-${process.pid}`);
      rmSync(partial, { recursive: true, force: true });
      try {
        for (const rel of listed.files) {
          const to = join(partial, rel);
          if (!to.startsWith(partial + sep)) continue;
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(join(dir, rel), to);
        }
        renameSync(partial, dest);
      } finally {
        rmSync(partial, { recursive: true, force: true });
      }
      result.added.push(this.row(root, id));
    }
    for (const id of ids ?? []) if (!seen.has(id)) result.skipped.push({ id, reason: 'not_found' });
    return result;
  }

  /** Removes `skills/<id>`; while roles list it, 409 (`details.roles`) unless `detach`. */
  remove(root: string, id: string, o: { detach: boolean }): { removed: true } {
    if (!Id.safeParse(id).success)
      throw new OrgEditError(400, 'bad_request', `"${id}" is not a skill id`);
    const dir = join(root, 'skills', id);
    if (!existsSync(dir)) throw new OrgEditError(404, 'not_found', `skill ${id} not found`);
    const org = loadOrg(root);
    const roles = Object.values(org.roles)
      .filter((r) => r.skills.includes(id))
      .map((r) => r.role)
      .sort();
    if (roles.length && !o.detach)
      throw new OrgEditError(
        409,
        'in_use',
        `skill ${id} is used by ${roles.join(', ')}: detach it from those roles first`,
        { roles },
      );
    detachFromRoles(root, 'skills', id);
    rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  }
}

/** The repository's name (`owner/name.git` → `name`). */
function repoName(url: string): string {
  return (
    basename(url)
      .replace(/\.git$/, '')
      .replace(/[^\w:-]/g, '-') || 'skill'
  );
}

/** `sub` inside the clone `dir`, which must exist and not leave it (through a symlink either). */
function inside(dir: string, sub: string): string {
  const base = resolve(dir, sub);
  if (!existsSync(base))
    throw new OrgEditError(404, 'not_found', `path "${sub}" is not in the repository`);
  const real = realpathSync(base);
  const realDir = realpathSync(dir);
  if (real !== realDir && !real.startsWith(realDir + sep))
    throw new OrgEditError(400, 'bad_request', `path "${sub}" leaves the repository`);
  return real === realDir ? dir : base;
}

/**
 * `git clone --depth 1 --no-recurse-submodules` without a shell, with a minimal environment
 * (no keys of the daemon), no prompt, a 60 s timeout and a 50 MB cap on what lands on disk.
 */
export function cloneShallow(
  url: string,
  dest: string,
  env: Record<string, string>,
  o: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<void> {
  const timeoutMs = o.timeoutMs ?? CLONE_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? CLONE_MAX;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--no-recurse-submodules',
        '--quiet',
        '--',
        url,
        dest,
      ],
      {
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let stderr = '';
    let failure: string | undefined;
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const kill = (why: string) => {
      failure ??= why;
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(
      () => kill(`the clone took longer than ${timeoutMs / 1000} s`),
      timeoutMs,
    );
    const poll = setInterval(() => {
      if (dirSize(dest) > maxBytes)
        kill(`the repository is larger than ${maxBytes / 1_000_000} MB`);
    }, 250);
    const done = (err?: string) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (!err && dirSize(dest) > maxBytes)
        err = `the repository is larger than ${maxBytes / 1_000_000} MB`;
      if (err)
        reject(new OrgEditError(failure ? 413 : 502, failure ? 'too_large' : 'clone_failed', err));
      else resolvePromise();
    };
    child.on('error', (e) => done(`git could not run: ${e.message}`));
    child.on('close', (code) => {
      if (failure) return done(failure);
      if (code !== 0)
        return done(
          `git clone failed: ${stderr.trim().split('\n').pop()?.slice(0, 300) || `exit ${code}`}`,
        );
      done();
    });
  });
}
