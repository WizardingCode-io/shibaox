import type { KeyRow, McpServerRow, OrgConfig, RoleRow } from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import type { PluginRowModes } from './types.js';

/** The fields of a plugin (or of one of its modes) its key needs are read from. */
type KeyedPart = Pick<PluginRowModes, 'checks' | 'keys'>;

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
  /** Other names a plugin accepts in its place (`GH_TOKEN` or `GITHUB_TOKEN`). */
  alternatives?: string[];
  /** Set through this alternative (the row's own key is not). */
  via?: string;
}

/**
 * A plugin's keys as needs: keys named together in one check ("Token (GH_TOKEN or
 * GITHUB_TOKEN)") are alternatives of one need, met when any of them is present.
 */
export function pluginKeyNeeds(p: KeyedPart): { names: string[]; present: boolean }[] {
  const out: { names: string[]; present: boolean }[] = [];
  const seen = new Set<string>();
  for (const k of p.keys) {
    if (seen.has(k.name)) continue;
    const label = p.checks.find(
      (c) =>
        / or /.test(c.label) &&
        c.label.includes(k.name) &&
        p.keys.some((o) => o.name !== k.name && c.label.includes(o.name)),
    )?.label;
    const group = label ? p.keys.filter((o) => label.includes(o.name)) : [k];
    for (const g of group) seen.add(g.name);
    out.push({ names: group.map((g) => g.name), present: group.some((g) => g.present) });
  }
  return out;
}

export interface NeededKeysInput {
  config?: OrgConfig;
  roles: RoleRow[];
  mcp: McpServerRow[];
  plugins: PluginRowModes[];
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
  'HIGGSFIELD_API_KEY',
];

/**
 * The part of a plugin whose keys count: a mode chosen by name (`account`/`api`) is needed
 * even before it works, so its own keys; otherwise the top level (the active mode). Undefined:
 * the plugin is not set up and nothing chose it, so it needs nothing yet.
 */
function neededPart(p: PluginRowModes): KeyedPart | undefined {
  const chosen = p.mode?.configured;
  if (chosen === 'account' || chosen === 'api') return p.modes?.find((m) => m.id === chosen) ?? p;
  return p.status === 'off' ? undefined : p;
}

export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const prefixOf = (name: string) => norm(name.replace(/_(API_KEY|API_TOKEN|KEY|TOKEN)$/, ''));

/** A provider's key or endpoint URL (not built in, not custom). */
export const isProviderKey = (k: KeyRow): boolean =>
  !BUILT_IN_KEYS.includes(k.name) && k.description !== 'custom';

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
  /** Alternatives of a row (a plugin's), and whether anything needs the row's own key. */
  const alternatives = new Map<string, { names: string[]; present?: string }>();
  const strict = new Set<string>();
  const need = (name: string, by: NeededBy, isSet?: boolean) => {
    const list = needs.get(name) ?? [];
    if (!list.some((b) => b.label === by.label)) list.push(by);
    needs.set(name, list);
    if (isSet) present.set(name, true);
    if (by.kind !== 'plugin') strict.add(name);
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
  // a plugin that is not set up at all needs nothing yet (its keys stay in Other), unless a
  // mode of it was chosen by name (Higgsfield set to API needs its key now)
  for (const p of plugins) {
    const part = neededPart(p);
    if (!part) continue;
    for (const n of pluginKeyNeeds(part)) {
      const [first, ...rest] = n.names;
      if (!first) continue;
      const own = part.keys.find((k) => k.name === first)?.present;
      need(first, { kind: 'plugin', id: p.id, label: `plugin ${p.id}` }, own);
      if (rest.length) {
        const via = rest.find(
          (r) => part.keys.find((k) => k.name === r)?.present || known.get(r)?.set,
        );
        alternatives.set(first, { names: rest, ...(via ? { present: via } : {}) });
      }
    }
  }

  const line = (name: string): KeyLine => {
    const k = known.get(name);
    return {
      name,
      description: k?.description ?? '',
      set: k?.set ?? present.get(name) ?? false,
      // a key the vault does not list but the daemon sees: it comes from the environment
      ...(k?.source
        ? { source: k.source }
        : !k && present.get(name)
          ? { source: 'env' as const }
          : {}),
      ...(k?.masked ? { masked: k.masked } : {}),
      neededBy: needs.get(name) ?? [],
      models: [],
    };
  };
  /** A needed row: its alternatives meet it unless something reads the key itself. */
  const neededLine = (name: string): KeyLine => {
    const l = line(name);
    const alt = alternatives.get(name);
    if (!alt) return l;
    const via = !l.set && !strict.has(name) ? alt.present : undefined;
    return { ...l, alternatives: alt.names, ...(via ? { set: true, via } : {}) };
  };

  const needed = [...needs.keys()].map(neededLine);
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
