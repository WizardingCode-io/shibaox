import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrgConfig, writeOrgConfig } from '../src/org-config.js';
import { scaffoldOrg } from '../src/templates.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const org = () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgcfg-'));
  dirs.push(dir);
  scaffoldOrg(dir);
  return join(dir, 'org');
};

describe('org config', () => {
  it('reads what the dashboard shows: tiers, judge, adapter, budget', () => {
    const root = org();
    expect(readOrgConfig(root)).toEqual({
      root,
      organization: 'my-org',
      adapter: undefined,
      per_run_usd: 5,
      tiers: {
        strong: 'anthropic/claude-sonnet-5',
        cheap: 'ollama/llama3.2',
        decision: 'jev-latest',
      },
      judge: undefined,
    });
  });
  it('writes tiers, judge, adapter and budget, keeping comments and other keys', () => {
    const root = org();
    writeFileSync(
      join(root, 'models.yaml'),
      '# keep me\nproviders: {}\ntiers:\n  strong: anthropic/claude-sonnet-5   # strong\n  cheap: ollama/llama3.2\n  decision: jev-latest\nroles:\n  backend: { model: openai/gpt-5 }\ngates: {}\n',
    );
    const r = writeOrgConfig(root, {
      tiers: {
        strong: 'openrouter/anthropic/claude-sonnet-4.5',
        decision: 'openrouter/typesafe/jev-router',
      },
      judge: 'openrouter/typesafe/jev-router',
      adapter: 'direct',
      per_run_usd: 12,
    });
    expect(r.tiers).toEqual({
      strong: 'openrouter/anthropic/claude-sonnet-4.5',
      cheap: 'ollama/llama3.2',
      decision: 'openrouter/typesafe/jev-router',
    });
    const models = readFileSync(join(root, 'models.yaml'), 'utf8');
    expect(models).toContain('# keep me');
    expect(models).toContain('backend: { model: openai/gpt-5 }');
    expect(models).toContain('judge: openrouter/typesafe/jev-router');
    const loaded = loadOrg(root);
    expect(loaded.models.tiers.strong).toBe('openrouter/anthropic/claude-sonnet-4.5');
    expect(loaded.models.gates.judge).toBe('openrouter/typesafe/jev-router');
    expect(loaded.org.adapter).toBe('direct');
    expect(loaded.org.budgets.per_run_usd).toBe(12);
    expect(readFileSync(join(root, 'org.yaml'), 'utf8')).toContain('vault: ../vault');
    // null clears a value
    writeOrgConfig(root, { judge: null, adapter: null });
    expect(loadOrg(root).models.gates.judge).toBeUndefined();
    expect(loadOrg(root).org.adapter).toBeUndefined();
  });
  it('refuses values the org would not load', () => {
    const root = org();
    expect(() => writeOrgConfig(root, { tiers: { strong: 'not-a-ref' } })).toThrow(
      /provider\/model/,
    );
    expect(() => writeOrgConfig(root, { adapter: 'nope' as never })).toThrow(/adapter/);
    expect(() => writeOrgConfig(root, { per_run_usd: -1 })).toThrow(/budget/);
    expect(loadOrg(root).models.tiers.strong).toBe('anthropic/claude-sonnet-5'); // untouched
  });
  it('never leaves the org unloadable: bad types, empty adapter, unknown tiers are refused before any write', () => {
    const root = org();
    const before = readFileSync(join(root, 'models.yaml'), 'utf8');
    expect(() => writeOrgConfig(root, { adapter: '' as never })).toThrow(/adapter/);
    expect(() => writeOrgConfig(root, { per_run_usd: '10' as never })).toThrow(/budget/);
    expect(() => writeOrgConfig(root, { per_run_usd: Number.NaN })).toThrow(/budget/);
    expect(() => writeOrgConfig(root, { tiers: { foo: 'a/b' } as never })).toThrow(/tier/);
    expect(() => writeOrgConfig(root, { tiers: { strong: null } })).toThrow(/strong/);
    // a mixed patch that fails on org.yaml leaves models.yaml untouched too
    expect(() =>
      writeOrgConfig(root, { tiers: { strong: 'openrouter/x/y' }, adapter: 'nope' as never }),
    ).toThrow(/adapter/);
    expect(readFileSync(join(root, 'models.yaml'), 'utf8')).toBe(before);
    expect(() => loadOrg(root)).not.toThrow();
  });
  it('accepts jev-* only for the decision tier', () => {
    const root = org();
    expect(() => writeOrgConfig(root, { tiers: { strong: 'jev-latest' } })).toThrow(/strong/);
    expect(() => writeOrgConfig(root, { tiers: { cheap: 'jev-latest' } })).toThrow(/cheap/);
    expect(() => writeOrgConfig(root, { judge: 'jev-latest' })).toThrow(/judge/);
    expect(writeOrgConfig(root, { tiers: { decision: 'jev-latest' } }).tiers.decision).toBe(
      'jev-latest',
    );
  });
  it('clearing a value whose parent key is missing is a no-op', () => {
    const root = org();
    writeFileSync(join(root, 'models.yaml'), 'tiers:\n  strong: anthropic/claude-sonnet-5\n');
    writeFileSync(join(root, 'org.yaml'), 'organization: my-org\nteams: []\n');
    expect(() => writeOrgConfig(root, { judge: null, per_run_usd: null })).not.toThrow();
    expect(readOrgConfig(root).judge).toBeUndefined();
  });
  it('routing: jev on/off and cheap_min_confidence, written to models.yaml and read back', () => {
    const root = org();
    expect(readOrgConfig(root).routing).toBeUndefined();
    expect(writeOrgConfig(root, { routing: { jev: false } }).routing).toEqual({ jev: false });
    expect(readFileSync(join(root, 'models.yaml'), 'utf8')).toMatch(/routing:\n\s+jev: false/);
    expect(writeOrgConfig(root, { routing: { cheap_min_confidence: 0.8 } }).routing).toEqual({
      jev: false,
      cheap_min_confidence: 0.8,
    });
    expect(writeOrgConfig(root, { routing: { jev: true } }).routing?.jev).toBe(true);
    expect(loadOrg(root).models.routing).toEqual({ jev: true, cheap_min_confidence: 0.8 });
    // null goes back to the default
    expect(writeOrgConfig(root, { routing: { jev: null } }).routing).toEqual({
      cheap_min_confidence: 0.8,
    });
    expect(() => writeOrgConfig(root, { routing: { jev: 'yes' as never } })).toThrow(/routing/);
    expect(() => writeOrgConfig(root, { routing: { cheap_min_confidence: 1.5 } })).toThrow(
      /cheap_min_confidence/,
    );
  });
  it("the template's models.yaml explains routing", () => {
    const models = readFileSync(join(org(), 'models.yaml'), 'utf8');
    expect(models).toContain('# routing:');
    expect(models).toContain('cheap_min_confidence: 0.75');
  });
});
