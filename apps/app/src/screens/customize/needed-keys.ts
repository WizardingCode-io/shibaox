import type {
  KeyRow,
  McpServerRow,
  OrgConfig,
  PluginRow,
  RoleRow,
} from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';

/** Who needs a key: a badge in the Keys tab (`tier strong`, `connector github`, `plugin telegram`). */
export interface NeededBy {
  kind: 'tier' | 'judge' | 'role' | 'connector' | 'plugin';
  id: string;
  label: string;
}

/** One row of the Keys tab. */
export interface KeyLine {
  name: string;
  description: string;
  set: boolean;
  source?: 'vault' | 'env';
  masked?: string;
  neededBy: NeededBy[];
  /** The models this key unlocks (provider keys). */
  models: string[];
}

export interface NeededKeysInput {
  config?: OrgConfig;
  roles: RoleRow[];
  mcp: McpServerRow[];
  plugins: PluginRow[];
  models: ModelChoice[];
  keys: KeyRow[];
}

/** The keys shibaox itself knows (not a provider's), in the order the Other block shows them. */
export const BUILT_IN_KEYS = [
  'TYPESAFE_API_KEY',
  'SHIBAOX_TELEGRAM_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'SHIBAOX_DAEMON_TOKEN',
];

export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const prefixOf = (name: string) => norm(name.replace(/_(API_KEY|API_TOKEN|KEY|TOKEN)$/, ''));

/** A provider's key (not built in, not custom, not an endpoint URL). */
export const isProviderKey = (k: KeyRow): boolean =>
  !BUILT_IN_KEYS.includes(k.name) &&
  k.description !== 'custom' &&
  !/ endpoint$/.test(k.description);

/**
 * The key a provider reads: the missing key one of its models names, else the vault's provider
 * key whose name or provider name matches the provider id. Undefined for a local server.
 */
export function providerKey(
  provider: string,
  keys: KeyRow[],
  models: ModelChoice[],
): string | undefined {
  const own = models.filter((m) => m.provider === provider);
  if (own.some((m) => m.local)) return undefined;
  const missing = own.find((m) => !m.configured && m.missing?.length)?.missing?.[0];
  if (missing) return missing;
  const p = norm(provider);
  if (!p) return undefined;
  const candidates = keys.filter(isProviderKey);
  return (
    candidates.find((k) => prefixOf(k.name) === p) ??
    candidates.find((k) => {
      const pre = prefixOf(k.name);
      return pre.length >= 3 && (p.startsWith(pre) || pre.startsWith(p));
    }) ??
    candidates.find((k) => norm(k.description).startsWith(p))
  )?.name;
}

/** The keys a model needs (none for a local server). */
function modelKeys(ref: string, keys: KeyRow[], models: ModelChoice[]): string[] {
  if (/^jev-[\w.-]+$/i.test(ref)) return ['TYPESAFE_API_KEY'];
  const m = models.find((x) => x.ref === ref);
  if (m?.local) return [];
  if (m && !m.configured && m.missing?.length) return m.missing;
  const provider = m?.provider ?? ref.split('/')[0] ?? '';
  const k = providerKey(provider, keys, models);
  return k ? [k] : [];
}

const byName = (a: KeyLine, b: KeyLine) => a.name.localeCompare(b.name);

/**
 * The Keys tab, computed: the keys needed now (by the tiers, the roles' models, the catalog's
 * connectors and the plugins; missing first), one row per provider key (set first, with the
 * models it unlocks), and the rest (built in, endpoints, custom).
 */
export function neededKeys(input: NeededKeysInput): {
  needed: KeyLine[];
  providers: KeyLine[];
  other: KeyLine[];
} {
  const { config, roles, mcp, plugins, models, keys } = input;
  const known = new Map(keys.map((k) => [k.name, k]));
  const needs = new Map<string, NeededBy[]>();
  const present = new Map<string, boolean>();
  const need = (name: string, by: NeededBy, isSet?: boolean) => {
    const list = needs.get(name) ?? [];
    if (!list.some((b) => b.label === by.label)) list.push(by);
    needs.set(name, list);
    if (isSet) present.set(name, true);
  };
  for (const tier of ['strong', 'cheap', 'decision'] as const) {
    const ref = config?.tiers[tier];
    if (ref)
      for (const k of modelKeys(ref, keys, models))
        need(k, { kind: 'tier', id: tier, label: `tier ${tier}` });
  }
  if (config?.judge)
    for (const k of modelKeys(config.judge, keys, models))
      need(k, { kind: 'judge', id: 'judge', label: 'judge' });
  for (const r of roles)
    if (r.model)
      for (const k of modelKeys(r.model, keys, models))
        need(k, { kind: 'role', id: r.id, label: `role ${r.id}` });
  for (const s of mcp)
    for (const k of s.keys)
      need(k.name, { kind: 'connector', id: s.id, label: `connector ${s.id}` }, k.present);
  for (const p of plugins)
    for (const k of p.keys)
      need(k.name, { kind: 'plugin', id: p.id, label: `plugin ${p.id}` }, k.present);

  const line = (name: string): KeyLine => {
    const k = known.get(name);
    return {
      name,
      description: k?.description ?? '',
      set: k?.set ?? present.get(name) ?? false,
      ...(k?.source ? { source: k.source } : {}),
      ...(k?.masked ? { masked: k.masked } : {}),
      neededBy: needs.get(name) ?? [],
      models: [],
    };
  };

  const needed = [...needs.keys()].map(line);
  needed.sort((a, b) => (a.set === b.set ? byName(a, b) : a.set ? 1 : -1));

  const unlocks = new Map<string, string[]>();
  for (const m of models) {
    if (m.local) continue;
    for (const k of modelKeys(m.ref, keys, models))
      unlocks.set(k, [...(unlocks.get(k) ?? []), m.ref]);
  }
  const providers = keys
    .filter(isProviderKey)
    .map((k) => ({ ...line(k.name), models: unlocks.get(k.name) ?? [] }));
  providers.sort((a, b) => (a.set === b.set ? byName(a, b) : a.set ? -1 : 1));

  const builtIn = BUILT_IN_KEYS.filter((n) => known.has(n)).map(line);
  const rest = keys
    .filter((k) => !isProviderKey(k) && !BUILT_IN_KEYS.includes(k.name))
    .map((k) => line(k.name))
    .sort(byName);
  return { needed, providers, other: [...builtIn, ...rest] };
}
