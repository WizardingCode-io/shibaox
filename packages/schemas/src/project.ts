import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * `shibaox.yaml` at the root of a project: what a run needs to know about it that cannot be
 * guessed, or is guessed wrong. Every key is optional.
 */
export const ProjectFileSchema = z.object({
  /** The command that installs dependencies in a fresh worktree; `false` for none. Detected when absent. */
  setup: z.union([z.string().min(1), z.literal(false)]).optional(),
  setup_timeout_ms: z.number().int().positive().optional(),
  /** The test command of the `tests` check (detected when absent). */
  tests: z.string().min(1).optional(),
  /** The lint command of the `lint` check (detected when absent). */
  lint: z.string().min(1).optional(),
  /** Globs (relative to the project root) a run may not write without a `protected` approval. */
  protected: z.array(z.string().min(1)).default([]),
});
export type ProjectFile = z.infer<typeof ProjectFileSchema>;

export const PROJECT_FILE = 'shibaox.yaml';

/** The project file of `dir`, or undefined when there is none; an invalid one throws naming the file. */
export function loadProjectFile(dir: string): ProjectFile | undefined {
  const file = join(dir, PROJECT_FILE);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${PROJECT_FILE}: ${(e as Error).message}`);
  }
  const r = ProjectFileSchema.safeParse(raw ?? {});
  if (!r.success)
    throw new Error(
      `${PROJECT_FILE}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  return r.data;
}
