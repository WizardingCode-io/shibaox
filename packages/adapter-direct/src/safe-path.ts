import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `rel` against `workspace` and guarantees the result stays inside it:
 * rejects `../` escapes, absolute paths outside, and symlinks (on the deepest
 * existing ancestor, including dangling ones) that resolve outside.
 * Returns the lexical path under `workspace` (not its realpath).
 */
export function safePath(workspace: string, rel: string): string {
  const base = resolve(workspace);
  const root = realpathSync(base);
  const target = resolve(base, rel);
  const escapes = () => new Error(`path "${rel}" escapes workspace`);
  if (!inside(base, target)) throw escapes();
  // Resolve symlinks on the deepest existing ancestor (lstat so a dangling
  // symlink counts as existing and is not silently followed on write).
  let probe = target;
  while (!lexists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) throw escapes();
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    throw escapes(); // dangling symlink: its destination cannot be verified
  }
  if (!inside(root, real)) throw escapes();
  return target;
}
