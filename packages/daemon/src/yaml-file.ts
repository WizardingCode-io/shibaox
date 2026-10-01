import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename } from 'node:path';
import { parseDocument } from 'yaml';

export type Doc = ReturnType<typeof parseDocument>;

/** A YAML file as a document (comments kept); an empty one when the file does not exist. */
export const readDoc = (path: string): Doc =>
  parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');

/** The first syntax error of a YAML document, as `<file> has a syntax error at line N: fix it first`. */
export function syntaxErrorOf(doc: Doc, path: string): string | undefined {
  const e = doc.errors[0];
  if (!e) return undefined;
  const line = e.linePos?.[0]?.line;
  return `${basename(path)} has a syntax error${line ? ` at line ${line}` : ''}: fix it first (${e.message.split('\n')[0]})`;
}

/**
 * The file is replaced in one step: a reader never sees a half-written file. A symlink is
 * followed (its target is replaced, the link stays) and the replaced file's mode is kept.
 */
export const writeAtomic = (path: string, text: string) => {
  const real = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(real) ? statSync(real).mode & 0o7777 : undefined;
  const tmp = `${real}.${process.pid}.tmp`;
  writeFileSync(tmp, text, mode !== undefined ? { mode } : {});
  // the umask may have narrowed it
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, real);
};
