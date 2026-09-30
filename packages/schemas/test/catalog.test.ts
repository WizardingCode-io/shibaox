import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogEntrySchema, loadOrg, RoleSchema } from '../src/index.js';

function org(extra: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cat-'));
  const files: Record<string, string> = {
    'org.yaml': 'organization: wc\nteams: [eng]\n',
    'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl]\ngates: []\nworkflows: []\n',
    'roles/tl.yaml': 'role: tl\n',
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

describe('catalog entries with an MCP server', () => {
  it('parses a stdio server and an http server, with defaults', () => {
    const stdio = CatalogEntrySchema.parse({
      id: 'playwright',
      type: 'mcp',
      description: 'Browser automation',
      server: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
    });
    expect(stdio.server?.timeout_ms).toBe(30_000);
    expect(stdio.server?.env_keys).toEqual([]);
    const http = CatalogEntrySchema.parse({
      id: 'docs',
      type: 'mcp',
      description: 'Docs search',
      server: {
        transport: 'http',
        url: 'https://mcp.example.com/mcp',
        env_keys: ['DOCS_TOKEN'],
        tools: ['search'],
      },
    });
    expect(http.server?.tools).toEqual(['search']);
  });
  it('an mcp entry without a server is a built-in marker; stdio needs a command; http needs an http(s) url', () => {
    expect(
      CatalogEntrySchema.parse({ id: 'graphify-mcp', type: 'mcp', description: 'd' }).server,
    ).toBeUndefined();
    expect(() =>
      CatalogEntrySchema.parse({
        id: 'x',
        type: 'mcp',
        description: 'd',
        server: { transport: 'stdio' },
      }),
    ).toThrow(/command/);
    expect(() =>
      CatalogEntrySchema.parse({
        id: 'x',
        type: 'mcp',
        description: 'd',
        server: { transport: 'http', url: 'ftp://x' },
      }),
    ).toThrow(/url/);
    // other entry types never carry a server
    expect(
      CatalogEntrySchema.parse({ id: 'y', type: 'skill', description: 'd' }).server,
    ).toBeUndefined();
  });
  it('a role lists the MCP servers and the skills it uses (none by default)', () => {
    const r = RoleSchema.parse({ role: 'qa', mcp: ['playwright'], skills: ['e2e'] });
    expect(r.mcp).toEqual(['playwright']);
    expect(r.skills).toEqual(['e2e']);
    expect(RoleSchema.parse({ role: 'x' }).mcp).toEqual([]);
    expect(RoleSchema.parse({ role: 'x' }).skills).toEqual([]);
  });
  it('loadOrg refuses a role naming an unknown mcp entry, a non-mcp entry, or a skill without SKILL.md', () => {
    expect(() => loadOrg(org({ 'roles/tl.yaml': 'role: tl\nmcp: [nope]\n' }))).toThrow(
      /roles\/tl\.yaml.*mcp server "nope" is not in catalog\//,
    );
    expect(() =>
      loadOrg(
        org({
          'roles/tl.yaml': 'role: tl\nmcp: [thing]\n',
          'catalog/thing.yaml': 'id: thing\ntype: tool\ndescription: a tool\n',
        }),
      ),
    ).toThrow(/"thing" is not an mcp entry/);
    expect(() =>
      loadOrg(
        org({
          'roles/tl.yaml': 'role: tl\nmcp: [graphify-mcp]\n',
          'catalog/graphify-mcp.yaml': 'id: graphify-mcp\ntype: mcp\ndescription: graph\n',
        }),
      ),
    ).toThrow(/"graphify-mcp" has no server/);
    expect(() => loadOrg(org({ 'roles/tl.yaml': 'role: tl\nskills: [e2e]\n' }))).toThrow(
      /skill "e2e" has no skills\/e2e\/SKILL\.md/,
    );
    for (const [id, why] of [
      ['shibaox', 'reserved'],
      ['graphify', 'reserved'],
      ['a:b', 'cannot be a tool name'],
      ['a__b', 'cannot be a tool name'],
    ] as const)
      expect(() =>
        loadOrg(
          org({
            'roles/tl.yaml': `role: tl\nmcp: ['${id}']\n`,
            [`catalog/${id}.yaml`]: `id: '${id}'\ntype: mcp\ndescription: x\nserver: { transport: stdio, command: node }\n`,
          }),
        ),
      ).toThrow(new RegExp(why));
    const ok = loadOrg(
      org({
        'roles/tl.yaml': 'role: tl\nmcp: [echo]\nskills: [e2e]\n',
        'catalog/echo.yaml':
          'id: echo\ntype: mcp\ndescription: echo\nserver: { transport: stdio, command: node }\n',
        'skills/e2e/SKILL.md': '# e2e\n',
      }),
    );
    expect(ok.roles.tl?.mcp).toEqual(['echo']);
  });
});
