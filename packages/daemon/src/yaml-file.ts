import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

export type Doc = ReturnType<typeof parseDocument>;

/** A YAML file as a document (comments kept); an empty one when the file does not exist. */
export const readDoc = (path: string): Doc =>
  parseDocument(existsSync(path) ? readFileSync(path, 'utf8') : '');

/** The file is replaced in one step: a reader never sees a half-written file. */
export const writeAtomic = (path: string, text: string) => {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};
