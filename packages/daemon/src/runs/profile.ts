import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  type ProjectProfile,
  profileProject,
  renderProfileNote,
} from '@wizardingcode/shibaox-core';
import { safeVaultPath } from '@wizardingcode/shibaox-memory';
import { projectName } from './workspace.js';

const cache = new Map<string, { at: number; profile: ProjectProfile }>();
const DEFAULT_CACHE_MS = 60_000;

/**
 * The profile of a project directory, cached per path; with a vault, the note
 * `10-projects/<project>/profile.md` is (re)written when the profile is computed.
 */
export function profileFor(
  path: string,
  o: { vault?: string; cacheMs?: number; log?: (l: string) => void } = {},
): ProjectProfile {
  const dir = resolve(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`project path not found: ${dir}`);
  const cacheMs = o.cacheMs ?? DEFAULT_CACHE_MS;
  const hit = cache.get(dir);
  if (hit && Date.now() - hit.at < cacheMs) return hit.profile;
  const profile = profileProject(dir);
  cache.set(dir, { at: Date.now(), profile });
  if (o.vault) {
    try {
      const note = safeVaultPath(o.vault, join('10-projects', projectName(dir), 'profile.md'));
      mkdirSync(dirname(note), { recursive: true });
      writeFileSync(note, renderProfileNote(profile));
    } catch (e) {
      o.log?.(`warn: profile note not written: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return profile;
}
