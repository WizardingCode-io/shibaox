import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
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
    readonly code: 'forbidden' | 'not_found' | 'no_workspace',
    message: string,
  ) {
    super(message);
    this.name = 'RunFileError';
    this.status = code === 'forbidden' ? 403 : 404;
  }
}

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
 * The absolute, real path of `rel` inside `root`, or a `forbidden` error: no absolute paths,
 * no `..`, and the resolved file (symlinks followed) must stay under the workspace.
 */
export function confine(root: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes('\0'))
    throw new RunFileError('forbidden', `${rel || '(empty)'} is not a path inside the workspace`);
  const parts = normalize(rel).split(/[\\/]/);
  if (parts.includes('..'))
    throw new RunFileError('forbidden', `${rel} is not a path inside the workspace`);
  const realRoot = realpathSync(root);
  const target = resolve(realRoot, rel);
  if (!existsSync(target)) throw new RunFileError('not_found', `no ${rel} in the workspace`);
  const real = realpathSync(target);
  if (real !== realRoot && !real.startsWith(realRoot + sep))
    throw new RunFileError('forbidden', `${rel} points outside the workspace`);
  return real;
}

/** A file of a run's workspace: text as utf8, binary as base64, capped at `maxBytes`. */
export async function readRunFile(
  root: string,
  rel: string,
  o: { maxBytes?: number } = {},
): Promise<RunFileContent> {
  if (!existsSync(root)) throw new RunFileError('no_workspace', 'The run workspace is gone');
  const file = confine(root, rel);
  const st = statSync(file);
  if (!st.isFile()) throw new RunFileError('not_found', `${rel} is not a file`);
  const max = o.maxBytes ?? RUN_FILE_LIMIT;
  const buf = readFileSync(file);
  const binary = looksBinary(buf);
  const slice = buf.subarray(0, max);
  return {
    path: rel,
    size: st.size,
    encoding: binary ? 'base64' : 'utf8',
    content: binary ? slice.toString('base64') : slice.toString('utf8'),
    truncated: buf.length > max,
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
    const rel = normalize(p).replace(/^[\\/]+/, '');
    if (!rel || rel.split(/[\\/]/).includes('..')) continue;
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
