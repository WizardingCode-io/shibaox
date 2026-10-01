import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpAdd, mcpRemove } from '../src/mcp.js';
import { listRoles, putRole } from '../src/roles.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function org(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edit-org-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  return join(dir, 'org');
}

describe('roles', () => {
  it('lists every role with its lists and the model of models.yaml roles', () => {
    const root = org();
    const rows = listRoles(root);
    const assistant = rows.find((r) => r.id === 'assistant');
    expect(assistant).toMatchObject({
      id: 'assistant',
      name: 'assistant',
      mcp: ['higgsfield'],
      skills: ['higgsfield'],
    });
    expect(assistant?.tools).toContain('read');
    expect(rows.map((r) => r.id)).toEqual([...rows.map((r) => r.id)].sort());
  });

  it('replaces mcp/skills lists, keeping comments, and validates every id', () => {
    const root = org();
    const row = putRole(root, 'assistant', { mcp: ['playwright', 'higgsfield'], skills: [] });
    expect(row).toMatchObject({ mcp: ['playwright', 'higgsfield'], skills: [] });
    const text = readFileSync(join(root, 'roles/assistant.yaml'), 'utf8');
    expect(text).toContain("# Higgsfield's tools");
    expect(text).toContain('mcp: [ playwright, higgsfield ]');
    expect(text).toContain('# execute: inline code');
    expect(loadOrg(root).roles.assistant?.mcp).toEqual(['playwright', 'higgsfield']);

    expect(() => putRole(root, 'assistant', { mcp: ['nope'] })).toThrow(/not in the catalog/);
    expect(() => putRole(root, 'assistant', { skills: ['nope'] })).toThrow(/no skills\/nope/);
    expect(() => putRole(root, 'assistant', { mcp: ['shibaox'] })).toThrow(/reserved/);
    expect(() => putRole(root, 'assistant', { mcp: 'x' as never })).toThrow(/list/);
    expect(() => putRole(root, 'ghost', { mcp: [] })).toThrow(/not found/);
    try {
      putRole(root, 'assistant', { mcp: ['nope'] });
    } catch (e) {
      expect((e as { status: number }).status).toBe(400);
    }
  });
});

describe('mcp add / remove', () => {
  it('writes catalog/<id>.yaml, attaches roles, 409 when it exists unless replace', () => {
    const root = org();
    const row = mcpAdd(
      root,
      {
        id: 'github',
        description: 'GitHub',
        server: {
          transport: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: `Bearer \${GH_TOKEN}` },
        },
        roles: ['assistant', 'backend'],
      },
      {},
    );
    expect(row).toMatchObject({
      id: 'github',
      transport: 'http',
      target: 'https://api.githubcopilot.com/mcp/',
      roles: ['assistant', 'backend'],
      // ${KEY} in a header is a key the server needs
      keys: [{ name: 'GH_TOKEN', present: false }],
    });
    const text = readFileSync(join(root, 'catalog/github.yaml'), 'utf8');
    expect(text).toContain('id: github');
    expect(text).not.toContain('args: []');
    expect(loadOrg(root).catalog.github?.server?.env_keys).toEqual(['GH_TOKEN']);
    let status = 0;
    try {
      mcpAdd(
        root,
        { id: 'github', description: 'x', server: { transport: 'stdio', command: 'x' } },
        {},
      );
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(409);
    const replaced = mcpAdd(
      root,
      {
        id: 'github',
        description: 'GitHub again',
        server: { transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
        replace: true,
      },
      {},
    );
    expect(replaced).toMatchObject({ description: 'GitHub again', target: 'npx -y x' });
    expect(() =>
      mcpAdd(
        root,
        { id: 'bad', description: 'b', server: { transport: 'http', url: 'ftp://x' } },
        {},
      ),
    ).toThrow(/http/);
    expect(() =>
      mcpAdd(
        root,
        { id: 'a__b', description: 'b', server: { transport: 'stdio', command: 'x' } },
        {},
      ),
    ).toThrow(/tool name/);
    expect(() =>
      mcpAdd(
        root,
        {
          id: 'ok',
          description: 'b',
          server: { transport: 'stdio', command: 'x' },
          roles: ['ghost'],
        },
        {},
      ),
    ).toThrow(/role ghost/);
    expect(existsSync(join(root, 'catalog/ok.yaml'))).toBe(false);
  });

  it('removes an entry after detaching it from every role', () => {
    const root = org();
    expect(mcpRemove(root, 'higgsfield')).toEqual({ removed: true });
    expect(existsSync(join(root, 'catalog/higgsfield.yaml'))).toBe(false);
    expect(loadOrg(root).roles.assistant?.mcp).toEqual([]);
    expect(() => mcpRemove(root, 'higgsfield')).toThrow(/not found/);
  });
});
