import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function inside(root: string, p: string): boolean {
  const r = relative(root, p);
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

function hasGitSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git');
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
 * With `write`, also refuses any path with a `.git` segment (case-insensitive):
 * writing `.git/config` or `.git/hooks/*` would give the model persistent code
 * execution through git (e.g. `core.fsmonitor`, hooks).
 * Returns the lexical path under `workspace` (not its realpath).
 */
export function safePath(workspace: string, rel: string, opts: { write?: boolean } = {}): string {
  const base = resolve(workspace);
  const root = realpathSync(base);
  const target = resolve(base, rel);
  const escapes = () => new Error(`path "${rel}" escapes workspace`);
  if (!inside(base, target)) throw escapes();
  const targetsGit = () => new Error(`path "${rel}" targets .git`);
  if (opts.write && hasGitSegment(relative(base, target))) throw targetsGit();
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
  // a symlink inside the workspace may point into .git: check the resolved path too
  if (opts.write && hasGitSegment(relative(root, join(real, relative(probe, target)))))
    throw targetsGit();
  return target;
}
