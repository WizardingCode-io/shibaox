import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the new-run form remembers between sessions (`<home>/ui.json`). */
export interface Prefs {
  lastOrg?: string;
  lastProject?: string;
  lastAdapter?: string;
  lastWorkspace?: string;
}

const KEYS: (keyof Prefs)[] = ['lastOrg', 'lastProject', 'lastAdapter', 'lastWorkspace'];

export function loadPrefs(home: string): Prefs {
  const file = join(home, 'ui.json');
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const out: Prefs = {};
    for (const k of KEYS) if (typeof raw[k] === 'string') out[k] = raw[k] as string;
    return out;
  } catch {
    return {};
  }
}

export function savePrefs(home: string, p: Prefs): void {
  mkdirSync(home, { recursive: true });
  const out: Prefs = {};
  for (const k of KEYS) if (p[k] !== undefined) out[k] = p[k];
  writeFileSync(join(home, 'ui.json'), `${JSON.stringify(out, null, 2)}\n`);
}
