import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isProtected } from '@wizardingcode/shibaox-core';
import type { DiffFile, DiffResult } from './diff.js';

export interface RunFile {
  path: string;
  status: DiffFile['status'];
  additions?: number;
  deletions?: number;
  /** Bytes on disk now (absent when the file is gone). */
  size?: number;
}

export interface RunFileContent {
  path: string;
  size: number;
  encoding: 'utf8' | 'base64';
  content: string;
  truncated: boolean;
  /** A media type guessed from the extension (binary files). */
  mime?: string;
}

export class RunFileError extends Error {
  readonly status: number;
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'no_workspace' | 'protected' | 'too_large' | 'busy',
    message: string,
  ) {
    super(message);
    this.name = 'RunFileError';
    this.status =
      code === 'forbidden' || code === 'protected'
        ? 403
        : code === 'too_large'
          ? 413
          : code === 'busy'
            ? 409
            : 404;
  }
}

/** Never served, whatever the run touched: secrets and the repository's own store. */
export const ALWAYS_PROTECTED = ['.env', '.env.*', '.git/**', '**/.env', '**/.env.*'];

export const RUN_FILE_LIMIT = 2_000_000;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  woff2: 'font/woff2',
  woff: 'font/woff',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  txt: 'text/plain',
};

export function mimeOf(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? MIME[ext] : undefined;
}

/** Text unless the first 8 KB carry a NUL byte (what git does). */
const looksBinary = (buf: Buffer): boolean => buf.subarray(0, 8192).includes(0);

/**
 * A workspace path as the run reports it (relative, or absolute inside the workspace) as the
 * relative path; undefined when it points outside, so a caller can drop it.
 */
export function relativeInWorkspace(root: string, p: string): string | undefined {
  if (!p || p.includes('\0')) return undefined;
  const inside = (rel: string) =>
    rel && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
      ? rel.replace(/\\/g, '/')
      : undefined;
  if (!isAbsolute(p)) return inside(normalize(p).replace(/^[\\/]+/, ''));
  // the root and the path may each be given through a symlink (/var vs /private/var): try both
  const roots = [root];
  const paths = [p];
  try {
    roots.push(realpathSync(root));
  } catch {
    // the root is gone: only the literal form can match
  }
  try {
    paths.push(realpathSync(p));
  } catch {
    // a path that does not exist yet (or any more): the literal form only
  }
  for (const r of roots)
    for (const x of paths) {
      const rel = inside(relative(r, x));
      if (rel !== undefined) return rel;
    }
  return undefined;
}

/**
 * The absolute, real path of `rel` inside `root` with its relative name, or a `forbidden`
 * error: no `..`, no path outside (symlinks followed), and an absolute path only when it is
 * inside the workspace. A missing file is `not_found`.
 */
export function confine(root: string, path: string): { file: string; rel: string } {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new RunFileError('no_workspace', 'The run workspace is gone');
  }
  if (path.endsWith('/') || path.endsWith('\\'))
    throw new RunFileError('not_found', `${path} is not a file`);
  const rel = relativeInWorkspace(realRoot, path);
  if (rel === undefined)
    throw new RunFileError('forbidden', `${path || '(empty)'} is not a path inside the workspace`);
  const target = resolve(realRoot, rel);
  let real: string;
  try {
    real = realpathSync(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM')
      throw new RunFileError('forbidden', `${rel} cannot be read`);
    throw new RunFileError('not_found', `no ${rel} in the workspace`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new RunFileError('forbidden', `${rel} points outside the workspace`);
  return { file: real, rel };
}

/** The first `max + 1` bytes of a file, without loading the rest. */
function readHead(file: string, max: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const n = readSync(fd, buf, 0, max + 1, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * A file of a run's workspace: text as utf8, binary as base64, at most `maxBytes` read from
 * disk. Protected files (`.env`, `.git`, the project's own globs) are never served.
 */
export async function readRunFile(
  root: string,
  path: string,
  o: { maxBytes?: number; protectedGlobs?: readonly string[] } = {},
): Promise<RunFileContent> {
  if (!existsSync(root)) throw new RunFileError('no_workspace', 'The run workspace is gone');
  const { file, rel } = confine(root, path);
  // protected by its own name or by the real file a link points at (cfg -> .env)
  const globs = [...ALWAYS_PROTECTED, ...(o.protectedGlobs ?? [])];
  if (isProtected(rel, globs) || isProtected(relative(realpathSync(root), file), globs))
    throw new RunFileError('protected', `${rel} is protected: it is never shown or downloaded`);
  const st = statSync(file);
  if (!st.isFile()) throw new RunFileError('not_found', `${rel} is not a file`);
  const max = o.maxBytes ?? RUN_FILE_LIMIT;
  const head = readHead(file, max);
  const binary = looksBinary(head);
  const slice = head.subarray(0, max);
  return {
    path: rel,
    size: st.size,
    encoding: binary ? 'base64' : 'utf8',
    content: binary ? slice.toString('base64') : slice.toString('utf8'),
    truncated: st.size > max,
    ...(binary ? { mime: mimeOf(rel) ?? 'application/octet-stream' } : {}),
  };
}

/** The diff's files plus the paths the run reported as changed, with their size now, sorted. */
export async function listRunFiles(
  root: string,
  diff: DiffResult | undefined,
  changed: readonly string[],
): Promise<RunFile[]> {
  const byPath = new Map<string, RunFile>();
  for (const f of diff?.files ?? [])
    byPath.set(f.path, {
      path: f.path,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    });
  for (const p of changed) {
    const rel = relativeInWorkspace(root, p);
    if (rel === undefined) continue; // outside the workspace: not the run's to list
    if (!byPath.has(rel)) byPath.set(rel, { path: rel, status: 'added' });
  }
  for (const f of byPath.values()) {
    const abs = join(root, f.path);
    try {
      const st = lstatSync(abs);
      if (st.isFile()) f.size = st.size;
    } catch {
      if (f.status !== 'deleted' && f.status !== 'renamed') f.status = 'deleted';
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Writes a text file into the workspace (the app's "Save to project" for a code block): the
 * same fence as reads (inside the root, through no symlink that leaves it, never a protected
 * file), directories created on the way, `too_large` past the cap. The relative path and size.
 */
export async function writeRunFile(
  root: string,
  path: string,
  content: string | Buffer,
  o: { protectedGlobs?: string[]; maxBytes?: number },
): Promise<{ path: string; size: number }> {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new RunFileError('no_workspace', 'The run workspace is gone');
  }
  if (path.endsWith('/') || path.endsWith('\\'))
    throw new RunFileError('not_found', `${path} is not a file name`);
  const rel = relativeInWorkspace(realRoot, path);
  if (rel === undefined)
    throw new RunFileError('forbidden', `${path || '(empty)'} is not a path inside the workspace`);
  const globs = [...ALWAYS_PROTECTED, ...(o.protectedGlobs ?? [])];
  if (isProtected(rel, globs))
    throw new RunFileError('protected', `${rel} is protected: it is never written from here`);
  const size = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
  const cap = o.maxBytes ?? RUN_FILE_LIMIT;
  if (size > cap)
    throw new RunFileError('too_large', `${rel} would be ${size} bytes; the cap is ${cap}`);
  const target = resolve(realRoot, rel);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  // the deepest directory that exists must really be inside the root (no symlink out), be a
  // directory, and the real spelling of the path must not be protected (d -> .git)
  let dir = dirname(target);
  while (!existsSync(dir)) dir = dirname(dir);
  const realDir = realpathSync(dir);
  if (!inside(realDir)) throw new RunFileError('forbidden', `${rel} points outside the workspace`);
  if (!statSync(realDir).isDirectory())
    throw new RunFileError(
      'not_found',
      `${relative(realRoot, realDir) || '.'} is a file, not a directory`,
    );
  const realRel = relative(realRoot, join(realDir, relative(dir, target)));
  if (isProtected(realRel, globs))
    throw new RunFileError('protected', `${rel} is protected: it is never written from here`);
  // the file itself is never written through a link: a link to a file elsewhere, to a protected
  // file, or dangling, is refused, and the open below (O_NOFOLLOW) refuses one that appears later
  let link: ReturnType<typeof lstatSync> | undefined;
  try {
    link = lstatSync(target);
  } catch {
    link = undefined;
  }
  if (link?.isSymbolicLink()) {
    // a link onto a protected file is as protected as the file; any other link is refused
    let real: string | undefined;
    try {
      real = realpathSync(target);
    } catch {
      real = undefined;
    }
    if (real && inside(real) && isProtected(relative(realRoot, real), globs))
      throw new RunFileError('protected', `${rel} is protected: it is never written from here`);
    throw new RunFileError('forbidden', `${rel} is a link: write to the file it points at instead`);
  }
  if (link?.isDirectory()) throw new RunFileError('not_found', `${rel} is a directory`);
  mkdirSync(dirname(target), { recursive: true });
  let fd: number;
  try {
    fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK')
      throw new RunFileError(
        'forbidden',
        `${rel} is a link: write to the file it points at instead`,
      );
    if (code === 'EISDIR') throw new RunFileError('not_found', `${rel} is a directory`);
    throw e;
  }
  try {
    if (typeof content === 'string') writeSync(fd, content, null, 'utf8');
    else writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return { path: rel, size };
}

/** A file the user sends with a message (the app's composer). */
export interface Attachment {
  name: string;
  /** base64 */
  content: string;
  mime?: string;
}
export const ATTACHMENTS_LIMIT = 25 * 1024 * 1024;
export const ATTACHMENTS_MAX = 20;

/** The file name an attachment gets: the base name, trailing dots and spaces gone, never empty. */
export function attachmentName(name: string): string {
  const base = basename(name.normalize('NFC').replace(/\\/g, '/'))
    .replace(/[\0/]/g, '')
    .trim()
    .replace(/[.\s]+$/, '');
  return !base || base === '.' || base === '..' ? 'file' : base;
}

/**
 * Writes a message's attachments under `attachments/` in the workspace (a clash gets `-2`,
 * `-3`…), with the same fence as any write; the relative paths, sizes and types, for the
 * message and the run's files.
 */
export async function writeAttachments(
  root: string,
  attachments: readonly Attachment[],
  o: { protectedGlobs?: string[] } = {},
): Promise<{ path: string; size: number; mime?: string }[]> {
  const out: { path: string; size: number; mime?: string }[] = [];
  const taken = new Set<string>();
  for (const a of attachments) {
    const name = attachmentName(a.name);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate) || existsSync(join(root, 'attachments', candidate)); n++)
      candidate = `${stem}-${n}${ext}`;
    taken.add(candidate);
    const rel = `attachments/${candidate}`;
    const bytes = Buffer.from(a.content, 'base64');
    const r = await writeRunFile(root, rel, bytes, o);
    out.push({ path: r.path, size: r.size, ...(a.mime ? { mime: a.mime } : {}) });
  }
  return out;
}
