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
import { bearerEnv, runArgv } from '@wizardingcode/shibaox-core';
import { Id, loadOrg } from '@wizardingcode/shibaox-schemas';
import { parse as parseYaml } from 'yaml';
import { detachFromRoles, OrgEditError } from './org-edit.js';
import { ORG_TEMPLATE } from './templates.js';
import { writeAtomic } from './yaml-file.js';

/** The skills shipped with Shibaox (the scaffold's `skills/<id>/SKILL.md`), by id. */
export const BUILTIN_SKILLS: Record<string, string> = Object.fromEntries(
  Object.entries(ORG_TEMPLATE).flatMap(([rel, content]) => {
    const m = /^org\/skills\/([^/]+)\/SKILL\.md$/.exec(rel);
    return m ? [[m[1] as string, content]] : [];
  }),
);

/** One skill of an org (`skills/<id>/SKILL.md`), with the roles that list it. */
export interface SkillRow {
  id: string;
  name: string;
  description: string;
  /** The SKILL.md file. */
  path: string;
  roles: string[];
}

/** A skill with its SKILL.md text (`GET /skills/:id`). */
export interface SkillDetail extends SkillRow {
  content: string;
}

/** Where skills come from: a git repository, a folder on the daemon's machine, or text. */
export type SkillAddRequest =
  | { source: 'repo'; repo: string; path?: string; ids?: string[] }
  | { source: 'folder'; path: string }
  | { source: 'inline'; id: string; content: string }
  /** A skill shipped with Shibaox; `replace` rewrites an existing SKILL.md with Shibaox's text. */
  | { source: 'builtin'; id: string; replace?: boolean };

/** An installed skill; `omitted` lists its files left out for being over 1 MB. */
export type SkillAdded = SkillRow & { omitted?: string[] };

export interface SkillAddResult {
  added: SkillAdded[];
  skipped: { id: string; reason: SkipReason }[];
}
export type SkipReason =
  | 'exists'
  | 'invalid_id'
  | 'symlink'
  | 'too_large'
  | 'not_found'
  | 'copy_failed';

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
export const CLONE_MAX_FILES = 20_000;
export const CLONE_TIMEOUT_MS = 60_000;
const DISCOVER_TTL_MS = 10 * 60_000;
const DISCOVER_FAIL_TTL_MS = 30_000;
const DISCOVER_CACHE_MAX = 50;
const STDERR_MAX = 4096;
/** ls-tree output beyond this is more files than the cap allows anyway. */
const LS_TREE_MAX = 32_000_000;
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

/** Whether a path was a symlink: on disk, or in the repository tree (checked out as a file). */
type IsLink = (absPath: string) => boolean;
const noLinks: IsLink = () => false;

/** Directories holding a SKILL.md under `base` (never through a symlink, never inside `.git`). */
function findSkillDirs(base: string, isLink: IsLink = noLinks): string[] {
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
      if (!isLink(p) && lstatSync(p).isDirectory()) walk(p, depth + 1);
    }
  };
  walk(base, 0);
  return out;
}

/** The regular files of a skill directory (relative paths) within the caps; symlinks never. */
function skillFiles(
  dir: string,
  isLink: IsLink,
): { files: string[]; omitted: string[] } | { reason: SkipReason } {
  const skillMd = join(dir, 'SKILL.md');
  if (lstatSync(skillMd).isSymbolicLink() || isLink(skillMd)) return { reason: 'symlink' };
  if (!isRegularFile(skillMd) || lstatSync(skillMd).size > SKILL_FILE_MAX)
    return { reason: 'too_large' };
  const files: string[] = [];
  const omitted: string[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.git') continue;
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || isLink(p)) continue;
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && st.size > SKILL_FILE_MAX) omitted.push(relative(dir, p));
      else if (st.isFile()) {
        total += st.size;
        files.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  if (total > SKILL_TOTAL_MAX) return { reason: 'too_large' };
  return { files, omitted };
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

const isFileRepo = (url: string) => !url.startsWith('https://');

/** A relative path inside a repository (no `..`, not absolute, no glob characters). */
function subPath(path: string | undefined): string {
  const p = (path ?? '')
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
  if (!p) return '';
  if (isAbsolute(p) || p.split(/[\\/]/).some((s) => s === '..' || s.startsWith('-')))
    throw new OrgEditError(400, 'bad_request', `"path" must be relative to the repository root`);
  if (/[*?[\]!#\\\0\n]/.test(p))
    throw new OrgEditError(400, 'bad_request', `"path" may not hold * ? [ ] ! # or \\`);
  return p;
}

/** One entry of `git ls-tree -r -l -z`. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
}
/** What a checkout would write: blob count and bytes, and the paths that are symlinks. */
export interface TreeStats {
  files: number;
  bytes: number;
  symlinks: string[];
  entries: TreeEntry[];
}

/** Parses `git ls-tree -r -l -z` (`<mode> <type> <object> <size>\t<path>\0`); submodules count for nothing. */
export function parseLsTree(out: string): TreeStats {
  const stats: TreeStats = { files: 0, bytes: 0, symlinks: [], entries: [] };
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode = '', type = '', , size = '-'] = rec.slice(0, tab).trim().split(/\s+/);
    const path = rec.slice(tab + 1);
    stats.entries.push({ path, mode, type });
    if (type !== 'blob') continue;
    stats.files++;
    stats.bytes += Number(size) || 0;
    if (mode === '120000') stats.symlinks.push(path);
  }
  return stats;
}

/** Refuses (413) a tree over the byte or file cap. */
export function checkTree(t: TreeStats, o: { maxBytes?: number; maxFiles?: number }): void {
  const maxBytes = o.maxBytes ?? CLONE_MAX;
  const maxFiles = o.maxFiles ?? CLONE_MAX_FILES;
  if (t.files > maxFiles)
    throw new OrgEditError(413, 'too_large', `the repository has more than ${maxFiles} files`);
  if (t.bytes > maxBytes)
    throw new OrgEditError(
      413,
      'too_large',
      `the repository is larger than ${maxBytes / 1_000_000} MB`,
    );
}

/**
 * `git` with no credential helper, only https (and file, for local callers' file repositories),
 * and symlinks checked out as plain files.
 */
export function gitArgv(args: string[], o: { file: boolean }): string[] {
  return [
    'git',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    ...(o.file ? ['-c', 'protocol.file.allow=always'] : []),
    '-c',
    'core.symlinks=false',
    ...args,
  ];
}

/** The environment git runs with: PATH, HOME and the locale only; no user or system config. */
export function gitEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    ...bearerEnv(env),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
}

export interface SkillsServiceOptions {
  /** The daemon's environment: git gets PATH (augmented), HOME and the locale only. */
  env: NodeJS.ProcessEnv;
  now?: () => number;
  /** Called on every clone, inside the one-clone-at-a-time lock (tests count them). */
  onClone?: (url: string) => void | Promise<void>;
  log?: (line: string) => void;
  /** Where clones go (default: the system temp dir). */
  tmpRoot?: string;
  /** The checkout cap in bytes (default 50 MB) and in files (default 20 000). */
  maxBytes?: number;
  maxFiles?: number;
  timeoutMs?: number;
  /** Copies one file of a skill (tests inject failures). */
  copyFile?: (from: string, to: string) => void;
}

type CacheEntry = { at: number; value?: SkillDiscovery; error?: unknown };

/** The org's skills: listing, installing (repository, folder, text), discovery and removal. */
export class SkillsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<SkillDiscovery>>();
  private readonly swept = new Set<string>();
  private readonly abort = new AbortController();
  /** One clone at a time per daemon. */
  private lock: Promise<void> = Promise.resolve();
  constructor(private readonly o: SkillsServiceOptions) {}

  /** Kills a clone in flight (the daemon is stopping); later clones are refused. */
  close(): void {
    this.abort.abort();
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Removes `.<id>.partial-*` copies an interrupted install left, once per org per process. */
  private sweep(root: string): void {
    if (this.swept.has(root)) return;
    this.swept.add(root);
    const dir = join(root, 'skills');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir))
      if (/^\..+\.partial-\d+$/.test(name))
        rmSync(join(dir, name), { recursive: true, force: true });
  }

  list(root: string): SkillRow[] {
    this.sweep(root);
    const org = loadOrg(root);
    const dir = join(root, 'skills');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((id) => Id.safeParse(id).success && isRegularFile(join(dir, id, 'SKILL.md')))
      .sort()
      .map((id) => this.row(root, id, org));
  }

  /** One skill with its SKILL.md text (at most 1 MB). */
  get(root: string, id: string): SkillDetail {
    if (!Id.safeParse(id).success)
      throw new OrgEditError(400, 'bad_request', `"${id}" is not a skill id`);
    this.sweep(root);
    const md = join(root, 'skills', id, 'SKILL.md');
    if (!isRegularFile(md)) throw new OrgEditError(404, 'not_found', `skill ${id} not found`);
    const content = readFileSync(md, 'utf8').slice(0, SKILL_FILE_MAX);
    return { ...this.row(root, id), content };
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

  private async exclusive<T>(f: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release = () => {};
    this.lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await f();
    } finally {
      release();
    }
  }

  /**
   * Clones `url` into a temp dir (one clone at a time), checks the tree of `sub` against the caps
   * before anything is checked out, checks out `sub` only, runs `use`, and removes the dir.
   */
  private withClone<T>(
    url: string,
    sub: string,
    use: (dir: string, isLink: IsLink) => T | Promise<T>,
  ): Promise<T> {
    return this.exclusive(async () => {
      const tmp = mkdtempSync(join(this.o.tmpRoot ?? tmpdir(), 'shibaox-skills-'));
      try {
        const dest = join(tmp, 'repo');
        await this.o.onClone?.(url);
        const tree = await this.clone(url, sub, tmp, dest);
        const links = new Set(tree.symlinks.map((p) => join(dest, p)));
        return await use(dest, (p) => links.has(p));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  private async clone(url: string, sub: string, cwd: string, dest: string): Promise<TreeStats> {
    const deadline = Date.now() + (this.o.timeoutMs ?? CLONE_TIMEOUT_MS);
    const file = isFileRepo(url);
    const env = gitEnv(this.o.env);
    const git = async (args: string[], at: string, maxStdoutBytes?: number) => {
      if (this.abort.signal.aborted)
        throw new OrgEditError(503, 'shutting_down', 'the daemon is stopping');
      const r = await runArgv({
        argv: gitArgv(args, { file }),
        cwd: at,
        env,
        inheritEnv: false,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal: this.abort.signal,
        maxStderrBytes: STDERR_MAX,
        ...(maxStdoutBytes ? { maxStdoutBytes } : {}),
      });
      if (r.aborted) throw new OrgEditError(503, 'shutting_down', 'the daemon is stopping');
      if (r.timedOut)
        throw new OrgEditError(
          413,
          'too_large',
          `the clone took longer than ${(this.o.timeoutMs ?? CLONE_TIMEOUT_MS) / 1000} s`,
        );
      if (r.overflow)
        throw new OrgEditError(
          413,
          'too_large',
          `the repository has more than ${this.o.maxFiles ?? CLONE_MAX_FILES} files`,
        );
      if (r.exitCode !== 0) {
        const last = r.stderr.trim().split('\n').pop()?.slice(0, 300);
        throw new OrgEditError(
          502,
          'clone_failed',
          `git ${args[0]} failed: ${last || `exit ${r.exitCode}`}`,
        );
      }
      return r.stdout;
    };
    await git(
      [
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--no-recurse-submodules',
        '--no-checkout',
        '--quiet',
        '--',
        url,
        dest,
      ],
      cwd,
    );
    const tree = parseLsTree(
      await git(
        ['ls-tree', '-r', '-l', '-z', 'HEAD', ...(sub ? ['--', sub] : [])],
        dest,
        LS_TREE_MAX,
      ),
    );
    if (sub) {
      if (tree.entries.length === 0)
        throw new OrgEditError(404, 'not_found', `path "${sub}" is not in the repository`);
      const self = tree.entries.find((e) => e.path === sub);
      if (self?.mode === '120000')
        throw new OrgEditError(
          400,
          'bad_request',
          `path "${sub}" is a symlink (it leaves the repository)`,
        );
      if (self) throw new OrgEditError(400, 'bad_request', `path "${sub}" is not a folder`);
    }
    checkTree(tree, { maxBytes: this.o.maxBytes, maxFiles: this.o.maxFiles });
    if (sub) await git(['sparse-checkout', 'set', '--no-cone', `/${sub}/`], dest);
    await git(['checkout', '--quiet'], dest);
    return tree;
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > DISCOVER_CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
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
    const hit = this.cache.get(key);
    if (hit) {
      const age = this.now() - hit.at;
      if (hit.value && age < DISCOVER_TTL_MS) return hit.value;
      if (hit.error && age < DISCOVER_FAIL_TTL_MS) throw hit.error;
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const p = (async () => {
      try {
        const value = await this.withClone(url, sub, (dir, isLink) => {
          const base = inside(dir, sub);
          return {
            repo,
            skills: findSkillDirs(base, isLink)
              .filter((d) => !isLink(join(d, 'SKILL.md')))
              .map((d) => {
                const id = d === dir ? repoName(url) : basename(d);
                const md = join(d, 'SKILL.md');
                const text = isRegularFile(md)
                  ? readFileSync(md, 'utf8').slice(0, SKILL_FILE_MAX)
                  : '';
                return { id, ...skillMeta(text, id), path: relative(dir, d) || '.' };
              }),
          };
        });
        this.remember(key, { at: this.now(), value });
        return value;
      } catch (e) {
        if (!(e instanceof OrgEditError && e.status === 503))
          this.remember(key, { at: this.now(), error: e });
        throw e;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  async add(root: string, req: SkillAddRequest, o: { local: boolean }): Promise<SkillAddResult> {
    loadOrg(root); // an org that does not load is not edited
    this.sweep(root);
    if (req?.source === 'inline') return this.addInline(root, req);
    if (req?.source === 'builtin') return this.addBuiltin(root, req);
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
      return this.install(root, findSkillDirs(base), (d) => basename(d), noLinks);
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
      return this.withClone(url, sub, (dir, isLink) =>
        this.install(
          root,
          findSkillDirs(inside(dir, sub), isLink),
          (d) => (d === dir ? repoName(url) : basename(d)),
          isLink,
          req.ids,
        ),
      );
    }
    throw new OrgEditError(400, 'bad_request', '"source" takes repo, folder, inline or builtin');
  }

  private addBuiltin(root: string, req: { id: string; replace?: boolean }): SkillAddResult {
    const content =
      typeof req.id === 'string' && Object.hasOwn(BUILTIN_SKILLS, req.id)
        ? BUILTIN_SKILLS[req.id]
        : undefined;
    if (content === undefined)
      throw new OrgEditError(
        404,
        'not_found',
        `no built-in skill "${String(req.id)}" (built-in: ${Object.keys(BUILTIN_SKILLS).join(', ')})`,
      );
    const dest = join(root, 'skills', req.id);
    if (!existsSync(dest)) return this.addInline(root, { id: req.id, content });
    if (req.replace !== true) return { added: [], skipped: [{ id: req.id, reason: 'exists' }] };
    // only SKILL.md is rewritten (in one step): other files the user put there stay
    writeAtomic(join(dest, 'SKILL.md'), content);
    return { added: [this.row(root, req.id)], skipped: [] };
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
    isLink: IsLink,
    ids?: string[],
  ): SkillAddResult {
    const result: SkillAddResult = { added: [], skipped: [] };
    const seen = new Set<string>();
    const skillsDir = join(root, 'skills');
    const copy = this.o.copyFile ?? copyFileSync;
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
      const listed = skillFiles(dir, isLink);
      if ('reason' in listed) {
        result.skipped.push({ id, reason: listed.reason });
        continue;
      }
      // copied aside, then renamed in one step: a run never sees half a skill
      const partial = join(skillsDir, `.${id}.partial-${process.pid}`);
      rmSync(partial, { recursive: true, force: true });
      let copied = false;
      try {
        mkdirSync(partial, { recursive: true });
        for (const rel of listed.files) {
          const to = join(partial, rel);
          if (!to.startsWith(partial + sep)) continue;
          mkdirSync(dirname(to), { recursive: true });
          copy(join(dir, rel), to);
        }
        renameSync(partial, dest);
        copied = true;
      } catch (e) {
        this.o.log?.(`skill ${id}: copy failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        rmSync(partial, { recursive: true, force: true });
      }
      if (!copied) {
        result.skipped.push({ id, reason: 'copy_failed' });
        continue;
      }
      result.added.push({
        ...this.row(root, id),
        ...(listed.omitted.length ? { omitted: listed.omitted } : {}),
      });
    }
    for (const id of ids ?? []) if (!seen.has(id)) result.skipped.push({ id, reason: 'not_found' });
    return result;
  }

  /** Removes `skills/<id>`; while roles list it, 409 (`details.roles`) unless `detach`. */
  remove(root: string, id: string, o: { detach: boolean }): { removed: true } {
    if (!Id.safeParse(id).success)
      throw new OrgEditError(400, 'bad_request', `"${id}" is not a skill id`);
    this.sweep(root);
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
