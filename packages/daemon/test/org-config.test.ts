import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@shibaox/schemas';
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
});
