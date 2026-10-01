import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpAdd, mcpList, mcpRemove } from '../src/mcp.js';
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
    expect(() => putRole(root, 'assistant', { mcp: ['nope'] })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
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
    expect(() =>
      mcpAdd(
        root,
        { id: 'github', description: 'x', server: { transport: 'stdio', command: 'x' } },
        {},
      ),
    ).toThrow(expect.objectContaining({ status: 409, code: 'exists' }));
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

const stdio = (command = 'x') => ({ transport: 'stdio' as const, command });

describe('mcp add: files, validation, secrets', () => {
  it('refuses (409 catalog_file_collision) when catalog/<id>.yaml holds another id', () => {
    const root = org();
    const other =
      'id: other\ntype: mcp\ndescription: Other\nserver:\n  transport: stdio\n  command: o\n';
    writeFileSync(join(root, 'catalog/svc.yaml'), other);
    expect(() => mcpAdd(root, { id: 'svc', description: 'S', server: stdio() }, {})).toThrow(
      expect.objectContaining({ status: 409, code: 'catalog_file_collision' }),
    );
    expect(readFileSync(join(root, 'catalog/svc.yaml'), 'utf8')).toBe(other);
  });

  it('replace edits the file that holds the id, whatever its name', () => {
    const root = org();
    writeFileSync(
      join(root, 'catalog/my-server.yaml'),
      '# mine\nid: svc\ntype: mcp\ndescription: Old\nserver:\n  transport: stdio\n  command: o\n',
    );
    mcpAdd(root, { id: 'svc', description: 'New', server: stdio('n'), replace: true }, {});
    expect(existsSync(join(root, 'catalog/svc.yaml'))).toBe(false);
    const text = readFileSync(join(root, 'catalog/my-server.yaml'), 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain('description: New');
  });

  it('validates the final document: bad tags are a 400 and nothing is written', () => {
    const root = org();
    const before = readFileSync(join(root, 'catalog/playwright.yaml'), 'utf8');
    const pw = loadOrg(root).catalog.playwright?.server as never;
    expect(() =>
      mcpAdd(
        root,
        { id: 'playwright', description: 'P', server: pw, replace: true, tags: {} as never },
        {},
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      mcpAdd(root, { id: 'n1', description: 'P', server: stdio(), tags: [1] as never }, {}),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(readFileSync(join(root, 'catalog/playwright.yaml'), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'catalog/n1.yaml'))).toBe(false);
  });

  it('refuses a literal secret in an auth/token/key header (400 secret_in_header)', () => {
    const root = org();
    const http = (headers: Record<string, string>) => ({
      transport: 'http' as const,
      url: 'https://x.example/mcp',
      headers,
    });
    for (const h of [
      { Authorization: 'Bearer abc123' },
      { 'X-Api-Key': 'abc' },
      { 'x-access-token': 'abc' },
    ])
      expect(() => mcpAdd(root, { id: 'h', description: 'H', server: http(h) }, {})).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'secret_in_header',
          message: expect.stringMatching(/vault/),
        }),
      );
    expect(existsSync(join(root, 'catalog/h.yaml'))).toBe(false);
    const ok = mcpAdd(
      root,
      { id: 'h', description: 'H', server: http({ 'X-Api-Key': `\${H_KEY}`, Accept: 'json' }) },
      {},
    );
    expect(ok.keys).toEqual([{ name: 'H_KEY', present: false }]);
  });

  it('replace with roles makes the attachment set exactly those roles; without roles, untouched', () => {
    const root = org();
    mcpAdd(
      root,
      { id: 'svc', description: 'S', server: stdio(), roles: ['assistant', 'backend'] },
      {},
    );
    const r1 = mcpAdd(
      root,
      { id: 'svc', description: 'S', server: stdio(), roles: ['backend'], replace: true },
      {},
    );
    expect(r1.roles).toEqual(['backend']);
    expect(loadOrg(root).roles.assistant?.mcp).not.toContain('svc');
    const r2 = mcpAdd(root, { id: 'svc', description: 'S2', server: stdio(), replace: true }, {});
    expect(r2.roles).toEqual(['backend']);
    const r3 = mcpAdd(
      root,
      { id: 'svc', description: 'S3', server: stdio(), roles: [], replace: true },
      {},
    );
    expect(r3.roles).toEqual([]);
  });

  it('a 409 for an entry that is not an mcp server says so', () => {
    const root = org();
    writeFileSync(join(root, 'catalog/tooly.yaml'), 'id: tooly\ntype: tool\ndescription: T\n');
    expect(() =>
      mcpAdd(root, { id: 'tooly', description: 'T', server: stdio(), replace: true }, {}),
    ).toThrow(expect.objectContaining({ status: 409, code: 'not_mcp' }));
    expect(() => mcpRemove(root, 'tooly')).toThrow(expect.objectContaining({ status: 404 }));
    expect(existsSync(join(root, 'catalog/tooly.yaml'))).toBe(true);
  });
});

describe('mcp list rows', () => {
  it('carry the raw server (placeholders kept) and keys from env_keys plus header placeholders', () => {
    const root = org();
    writeFileSync(
      join(root, 'catalog/hand.yaml'),
      [
        'id: hand',
        'type: mcp',
        'description: Hand-written',
        'server:',
        '  transport: http',
        '  url: https://h.example/mcp',
        '  headers:',
        `    Authorization: Bearer \${HAND_TOKEN}`,
        '  env_keys: [OTHER_KEY]',
        '',
      ].join('\n'),
    );
    const row = mcpList(root, { HAND_TOKEN: 't' }).find((r) => r.id === 'hand');
    expect(row?.server).toMatchObject({
      transport: 'http',
      url: 'https://h.example/mcp',
      headers: { Authorization: `Bearer \${HAND_TOKEN}` },
      env_keys: ['OTHER_KEY'],
    });
    expect(row?.keys).toEqual([
      { name: 'OTHER_KEY', present: false },
      { name: 'HAND_TOKEN', present: true },
    ]);
  });
});

describe('prototype-safe ids', () => {
  it('toString and friends are never found on the objects they index', () => {
    const root = org();
    const assistant = readFileSync(join(root, 'roles/assistant.yaml'), 'utf8');
    expect(() => putRole(root, 'assistant', { mcp: ['toString'] })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => putRole(root, 'toString', { mcp: [] })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => putRole(root, 'constructor', { mcp: [] })).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() =>
      mcpAdd(root, { id: 'svc', description: 'S', server: stdio(), roles: ['toString'] }, {}),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(existsSync(join(root, 'catalog/svc.yaml'))).toBe(false);
    expect(() => mcpRemove(root, 'toString')).toThrow(expect.objectContaining({ status: 404 }));
    // a bad role among good ones: nothing written
    expect(() =>
      mcpAdd(
        root,
        { id: 'svc', description: 'S', server: stdio(), roles: ['assistant', 'hasOwnProperty'] },
        {},
      ),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(readFileSync(join(root, 'roles/assistant.yaml'), 'utf8')).toBe(assistant);
  });

  it('PUT a role with an mcp entry that has no server is a 400', () => {
    const root = org();
    writeFileSync(join(root, 'catalog/marker.yaml'), 'id: marker\ntype: mcp\ndescription: M\n');
    expect(() => putRole(root, 'assistant', { mcp: ['marker'] })).toThrow(
      expect.objectContaining({ status: 400, message: expect.stringMatching(/server/) }),
    );
  });
});
