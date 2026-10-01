import type {
  KeyRow,
  McpServerRow,
  OrgConfig,
  PluginRow,
  RoleRow,
} from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import { describe, expect, it } from 'vitest';
import { neededKeys, providerKey } from '../src/screens/customize/needed-keys.js';

const keys: KeyRow[] = [
  { name: 'TYPESAFE_API_KEY', description: 'Jev decisions and checks (TypeSafe)', set: false },
  { name: 'SHIBAOX_TELEGRAM_TOKEN', description: 'Telegram bot', set: false },
  {
    name: 'GH_TOKEN',
    description: 'GitHub',
    set: true,
    source: 'env',
    masked: 'ghp_…1234',
  },
  { name: 'GITHUB_TOKEN', description: 'GitHub (fallback)', set: false },
  { name: 'SHIBAOX_DAEMON_TOKEN', description: 'daemon token', set: false },
  {
    name: 'ANTHROPIC_API_KEY',
    description: 'Anthropic (API key)',
    set: true,
    source: 'vault',
    masked: 'sk-a…7890',
  },
  { name: 'OPENAI_API_KEY', description: 'OpenAI (API key)', set: false },
  { name: 'OPENROUTER_API_KEY', description: 'OpenRouter', set: false },
  { name: 'MISTRAL_API_KEY', description: 'Mistral', set: false },
  { name: 'ARK_API_KEY', description: 'Volcengine Ark', set: false },
  { name: 'VYDRA_BASE_URL', description: 'Vydra endpoint', set: false },
  { name: 'MY_CUSTOM', description: 'custom', set: true, source: 'vault', masked: '••••' },
];

const models: ModelChoice[] = [
  { ref: 'anthropic/claude-opus', provider: 'anthropic', model: 'claude-opus', configured: true },
  {
    ref: 'anthropic/claude-haiku',
    provider: 'anthropic',
    model: 'claude-haiku',
    configured: true,
  },
  {
    ref: 'openai/gpt-5-mini',
    provider: 'openai',
    model: 'gpt-5-mini',
    configured: false,
    missing: ['OPENAI_API_KEY'],
  },
  {
    ref: 'lmstudio/qwen',
    provider: 'lmstudio',
    model: 'qwen',
    configured: true,
    local: true,
    available: true,
  },
  {
    ref: 'volcengine/doubao',
    provider: 'volcengine',
    model: 'doubao',
    configured: false,
    missing: ['ARK_API_KEY'],
  },
];

const config: OrgConfig = {
  root: '/o',
  organization: 'wc',
  tiers: {
    strong: 'anthropic/claude-opus',
    cheap: 'openai/gpt-5-mini',
    decision: 'openrouter/typesafe/jev-router',
  },
  judge: 'lmstudio/qwen',
};

const roles: RoleRow[] = [
  { id: 'assistant', name: 'Assistant', tools: [], mcp: ['github'], skills: [] },
  {
    id: 'reviewer',
    name: 'Reviewer',
    model: 'mistral/mistral-large',
    tools: [],
    mcp: [],
    skills: [],
  },
];

const mcp: McpServerRow[] = [
  {
    id: 'github',
    description: 'GitHub',
    transport: 'http',
    target: 'https://api.githubcopilot.com/mcp/',
    roles: ['assistant'],
    keys: [{ name: 'GH_TOKEN', present: true }],
  },
  {
    id: 'firecrawl',
    description: 'Scrape',
    transport: 'stdio',
    target: 'npx -y firecrawl-mcp',
    roles: [],
    keys: [{ name: 'FIRECRAWL_API_KEY', present: false }],
  },
];

const plugins: PluginRow[] = [
  {
    id: 'telegram',
    name: 'Telegram',
    description: 'Talk to Shibaox from Telegram',
    status: 'off',
    checks: [],
    keys: [{ name: 'SHIBAOX_TELEGRAM_TOKEN', present: false }],
    actions: [],
    brings: { connectors: [], skills: [] },
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'The GitHub loop',
    status: 'ready',
    checks: [],
    keys: [{ name: 'GH_TOKEN', present: true }],
    actions: [],
    brings: { connectors: ['github'], skills: [] },
  },
];

describe('neededKeys', () => {
  const r = neededKeys({ config, roles, mcp, plugins, models, keys });
  const row = (name: string) => r.needed.find((x) => x.name === name);

  it('collects the keys of the tiers, the roles, the connectors and the plugins, missing first', () => {
    expect(r.needed.map((x) => x.name)).toEqual([
      // missing, by name
      'FIRECRAWL_API_KEY',
      'MISTRAL_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'SHIBAOX_TELEGRAM_TOKEN',
      // set, by name
      'ANTHROPIC_API_KEY',
      'GH_TOKEN',
    ]);
    // a local model needs no key
    expect(r.needed.some((x) => x.neededBy.some((b) => b.label === 'judge'))).toBe(false);
  });

  it('says who needs each key, as badges', () => {
    expect(row('ANTHROPIC_API_KEY')?.neededBy.map((b) => b.label)).toEqual(['tier strong']);
    expect(row('OPENAI_API_KEY')?.neededBy.map((b) => b.label)).toEqual(['tier cheap']);
    expect(row('OPENROUTER_API_KEY')?.neededBy.map((b) => b.label)).toEqual(['tier decision']);
    expect(row('MISTRAL_API_KEY')?.neededBy.map((b) => b.label)).toEqual(['role reviewer']);
    expect(row('GH_TOKEN')?.neededBy.map((b) => b.label)).toEqual([
      'connector github',
      'plugin github',
    ]);
    expect(row('FIRECRAWL_API_KEY')?.neededBy.map((b) => b.label)).toEqual(['connector firecrawl']);
    expect(row('SHIBAOX_TELEGRAM_TOKEN')?.neededBy.map((b) => b.label)).toEqual([
      'plugin telegram',
    ]);
  });

  it('keeps the status of the vault: set, masked, where from', () => {
    expect(row('GH_TOKEN')).toMatchObject({ set: true, source: 'env', masked: 'ghp_…1234' });
    expect(row('ANTHROPIC_API_KEY')).toMatchObject({ set: true, source: 'vault' });
    // a key the vault does not know (a connector's) is missing with no description
    expect(row('FIRECRAWL_API_KEY')).toMatchObject({ set: false });
  });

  it('a jev decision tier needs the TypeSafe key', () => {
    const j = neededKeys({
      config: { ...config, tiers: { decision: 'jev-latest' } },
      roles: [],
      mcp: [],
      plugins: [],
      models,
      keys,
    });
    expect(j.needed.map((x) => [x.name, x.neededBy.map((b) => b.label)])).toEqual([
      ['TYPESAFE_API_KEY', ['tier decision']],
    ]);
  });

  it('providers: one row per provider key, set first, with the models each unlocks', () => {
    expect(r.providers.map((x) => x.name)).toEqual([
      'ANTHROPIC_API_KEY',
      'ARK_API_KEY',
      'MISTRAL_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
    ]);
    expect(r.providers[0]?.models).toEqual(['anthropic/claude-opus', 'anthropic/claude-haiku']);
    expect(r.providers.find((x) => x.name === 'ARK_API_KEY')?.models).toEqual([
      'volcengine/doubao',
    ]);
    expect(r.providers.find((x) => x.name === 'OPENAI_API_KEY')?.neededBy[0]?.label).toBe(
      'tier cheap',
    );
  });

  it('other: the built-in keys, the endpoints and the custom keys', () => {
    expect(r.other.map((x) => x.name)).toEqual([
      'TYPESAFE_API_KEY',
      'SHIBAOX_TELEGRAM_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'SHIBAOX_DAEMON_TOKEN',
      'MY_CUSTOM',
      'VYDRA_BASE_URL',
    ]);
  });

  it('works before the org config and the roles are known', () => {
    const e = neededKeys({ roles: [], mcp: [], plugins: [], models: [], keys: [] });
    expect(e).toEqual({ needed: [], providers: [], other: [] });
  });
});

describe('providerKey', () => {
  it('reads the missing key of a model first, then matches the key name or the provider name', () => {
    expect(providerKey('openai', keys, models)).toBe('OPENAI_API_KEY');
    expect(providerKey('anthropic', keys, models)).toBe('ANTHROPIC_API_KEY');
    expect(providerKey('volcengine', keys, [])).toBe('ARK_API_KEY');
    expect(providerKey('openrouter', keys, [])).toBe('OPENROUTER_API_KEY');
    expect(providerKey('lmstudio', keys, models)).toBeUndefined();
  });
});
