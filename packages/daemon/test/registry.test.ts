import { mcpIdProblem } from '@wizardingcode/shibaox-core';
import { CatalogEntrySchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CONNECTOR_CATEGORIES, connectorRegistry } from '../src/registry/connectors.js';
import { skillSources } from '../src/registry/skills.js';
import { ORG_TEMPLATE } from '../src/templates.js';

describe('connector registry', () => {
  const all = connectorRegistry();
  it('every template parses as a catalog mcp entry and has a valid id and category', () => {
    expect(all.length).toBe(19);
    for (const t of all) {
      const r = CatalogEntrySchema.safeParse({
        id: t.id,
        type: 'mcp',
        description: t.description,
        server: t.server,
      });
      expect(r.success, `${t.id}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
      expect(mcpIdProblem(t.id)).toBeUndefined();
      expect(CONNECTOR_CATEGORIES).toContain(t.category);
      // every key a server reads is declared, with a description
      for (const k of t.server.env_keys) expect(t.keys.map((x) => x.name)).toContain(k);
      for (const k of t.keys) expect(k.description).toBeTruthy();
    }
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });
  it('Higgsfield and Playwright are the scaffold templates, not copies', () => {
    const hf = parse(ORG_TEMPLATE['org/catalog/higgsfield.yaml'] as string);
    const h = all.find((t) => t.id === 'higgsfield');
    expect(h?.server).toMatchObject(hf.server);
    expect(h).toMatchObject({ verified: true, category: 'Design & media', skills: ['higgsfield'] });
    const pw = parse(ORG_TEMPLATE['org/catalog/playwright.yaml'] as string);
    expect(all.find((t) => t.id === 'playwright')?.server).toMatchObject(pw.server);
  });
  it('GitHub uses the Copilot MCP with the GH_TOKEN bearer; keys carry signup links', () => {
    const gh = all.find((t) => t.id === 'github');
    expect(gh?.server).toMatchObject({
      transport: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: `Bearer \${GH_TOKEN}` },
      env_keys: ['GH_TOKEN'],
    });
    expect(gh?.keys[0]?.signupUrl).toMatch(/^https:\/\/github.com\//);
    for (const id of ['exa', 'firecrawl', 'brave-search', 'stripe'])
      expect(all.find((t) => t.id === id)?.keys[0]?.signupUrl, id).toMatch(/^https:\/\//);
  });
  it('drops the archived servers and says which runtime can sign in with OAuth', () => {
    const ids = all.map((t) => t.id);
    expect(ids).not.toContain('postgres');
    expect(ids).not.toContain('slack');
    for (const id of ['notion', 'linear', 'sentry', 'supabase', 'figma', 'vercel'])
      expect(all.find((t) => t.id === id)?.note, id).toBe(
        'Signs in with OAuth through the Claude Code runtime; the direct runtime cannot sign in yet',
      );
  });
  it('Brave uses its own package; Exa takes an optional key in the URL; Filesystem asks for a path', () => {
    expect(all.find((t) => t.id === 'brave-search')?.server.args).toEqual([
      '-y',
      '@brave/brave-search-mcp-server',
    ]);
    const exa = all.find((t) => t.id === 'exa');
    expect(exa?.server.headers).toEqual({});
    expect(exa?.server.env_keys).toEqual([]);
    expect(exa?.keys[0]).toMatchObject({ name: 'EXA_API_KEY', optional: true });
    expect(exa?.note).toMatch(/\?exaApiKey=/);
    const fs = all.find((t) => t.id === 'filesystem');
    expect(fs?.server.args.at(-1)).toBe('/path/to/allow');
    expect(fs?.note).toMatch(/\/path\/to\/allow/);
  });
});

describe('skill sources', () => {
  it('lists the built-in repositories', () => {
    expect(skillSources().map((s) => s.repo)).toEqual([
      'anthropics/skills',
      'higgsfield-ai/skills',
    ]);
  });
});
