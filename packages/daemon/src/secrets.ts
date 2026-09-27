import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { loadCatalog } from '@shibaox/providers';

export interface KnownKey {
  name: string;
  description: string;
}

export interface KeyRow extends KnownKey {
  set: boolean;
  /** Where the value in use comes from. */
  source?: 'vault' | 'env';
  /** The value with its middle hidden (`sk-o…7890`). */
  masked?: string;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const BUILT_IN: KnownKey[] = [
  { name: 'TYPESAFE_API_KEY', description: 'Jev decisions and checks (TypeSafe)' },
  { name: 'SHIBAOX_TELEGRAM_TOKEN', description: 'Telegram bot (channels.telegram)' },
];

/** The keys shibaox knows what to do with: every provider's, plus Jev and Telegram. */
export const KNOWN_KEYS: KnownKey[] = (() => {
  const out = new Map<string, KnownKey>();
  for (const k of BUILT_IN) out.set(k.name, k);
  for (const e of loadCatalog()) {
    if (e.auth?.type === 'api_key' && !out.has(e.auth.env))
      out.set(e.auth.env, { name: e.auth.env, description: e.name });
    if (e.base_url_env && !out.has(e.base_url_env))
      out.set(e.base_url_env, { name: e.base_url_env, description: `${e.name} endpoint` });
  }
  return [...out.values()];
})();

/** `sk-o…7890`; short values are hidden whole. */
export function maskSecret(value: string): string {
  if (value.length < 12) return '•'.repeat(Math.min(value.length, 8));
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

interface FileShape {
  version: 1;
  keys: Record<string, string>;
}

/**
 * The key vault: a 0600 JSON file under the shibaox home (`secrets.json`), shared by the
 * daemon, the CLI and the dashboard through the daemon's API. Values never leave it except
 * into the environment the runtimes get; listings carry a masked form only.
 */
export class SecretsStore {
  constructor(readonly path: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<FileShape>;
      return raw.keys && typeof raw.keys === 'object' ? { ...raw.keys } : {};
    } catch {
      return {};
    }
  }

  private write(keys: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    const body: FileShape = { version: 1, keys };
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get(name: string): string | undefined {
    return this.read()[name];
  }

  set(name: string, value: string): void {
    if (!NAME_RE.test(name))
      throw new Error(`key name "${name}" must look like an environment variable (OPENAI_API_KEY)`);
    const v = value.trim();
    if (!v) throw new Error('key value is empty');
    const keys = this.read();
    keys[name] = v;
    this.write(keys);
  }

  unset(name: string): boolean {
    const keys = this.read();
    if (!(name in keys)) return false;
    delete keys[name];
    if (Object.keys(keys).length === 0) {
      if (existsSync(this.path)) unlinkSync(this.path);
      return true;
    }
    this.write(keys);
    return true;
  }

  /** `base` with the vault on top: what the runtimes, providers and channels see. */
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...base, ...this.read() };
  }

  /** Every known key (and any extra one in the vault) with its state; values stay masked. */
  list(base: NodeJS.ProcessEnv): KeyRow[] {
    const vault = this.read();
    const names = new Map<string, KnownKey>(KNOWN_KEYS.map((k) => [k.name, k]));
    for (const name of Object.keys(vault))
      if (!names.has(name)) names.set(name, { name, description: 'custom' });
    return [...names.values()].map((k) => {
      const fromVault = vault[k.name];
      const fromEnv = base[k.name];
      const value = fromVault ?? fromEnv;
      return {
        ...k,
        set: value !== undefined && value !== '',
        ...(fromVault !== undefined
          ? { source: 'vault' as const }
          : fromEnv
            ? { source: 'env' as const }
            : {}),
        ...(value ? { masked: maskSecret(value) } : {}),
      };
    });
  }
}
