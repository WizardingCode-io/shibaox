import { CatalogEntrySchema, RoleSchema, TeamSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { AUTOROUTE_REQUEST_MAX_CHARS, selectCapabilities } from '../src/index.js';

const catalog = [
  CatalogEntrySchema.parse({
    id: 'graphify-mcp',
    type: 'mcp',
    description: 'Knowledge graph of the codebase',
    tags: ['code', 'backend', 'analyst'],
  }),
  CatalogEntrySchema.parse({
    id: 'figma-mcp',
    type: 'mcp',
    description: 'Design files',
    tags: ['design'],
  }),
  CatalogEntrySchema.parse({
    id: 'tdd-skill',
    type: 'skill',
    description: 'Test-driven development',
    tags: ['backend', 'write-code'],
  }),
];
const role = RoleSchema.parse({ role: 'backend', capabilities: ['write-code'], tools: ['git'] });

describe('selectCapabilities', () => {
  it('deterministic mode attaches exact role/capability tag matches and marks the rest ambiguous', async () => {
    const r = await selectCapabilities({ request: 'add /health endpoint', role, catalog });
    expect(r.attach.sort()).toEqual(['graphify-mcp', 'tdd-skill']);
    expect(r.ambiguous).toEqual(['figma-mcp']);
  });
  it('with a fan-out, applies thresholds and never attaches below them or outside the catalog', async () => {
    const fanOut = async (_s: string, q: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(q).map((k) => [
          k,
          { noul: k.includes('graphify') ? 0.95 : k.includes('tdd') ? 0.6 : 0.1 },
        ]),
      );
    const r = await selectCapabilities({ request: 'add /health endpoint', role, catalog, fanOut });
    expect(r.attach).toEqual(['graphify-mcp']);
    expect(r.ambiguous).toEqual(['tdd-skill']);
    expect(r.dropped).toEqual(['figma-mcp']);
  });
  it('caps candidates at 40 and prefers tag matches', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      CatalogEntrySchema.parse({
        id: `s${i}`,
        type: 'skill',
        description: `skill ${i}`,
        tags: i < 5 ? ['backend'] : ['other'],
      }),
    );
    const r = await selectCapabilities({
      request: 'x',
      role,
      catalog: many,
      fanOut: async (_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])),
    });
    expect(r.attach.length + r.ambiguous.length + r.dropped.length).toBeLessThanOrEqual(40);
    expect(r.attach).toEqual(expect.arrayContaining(['s0', 's1', 's2', 's3', 's4']));
  });
  it('caps the request text forwarded to fanOut regardless of the input size', async () => {
    const longRequest = 'x'.repeat(50_000);
    let seenState = '';
    const fanOut = async (state: string, q: Record<string, unknown>) => {
      seenState = state;
      return Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }]));
    };
    await selectCapabilities({ request: longRequest, role, catalog, fanOut });
    expect(seenState.length).toBeLessThanOrEqual(AUTOROUTE_REQUEST_MAX_CHARS);
  });
});

describe('selectCapabilities with a team', () => {
  it('also matches tags shared with the team roster', async () => {
    const team = TeamSchema.parse({ team: 'eng', lead: 'tl', roles: ['backend', 'design'] });
    const soloRole = RoleSchema.parse({ role: 'tl', capabilities: [], tools: [] });
    const r = await selectCapabilities({
      request: 'add /health endpoint',
      role: soloRole,
      team,
      catalog,
    });
    expect(r.attach.sort()).toEqual(['figma-mcp', 'graphify-mcp', 'tdd-skill']);
    expect(r.ambiguous).toEqual([]);
  });
});
