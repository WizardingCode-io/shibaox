import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonHttpError } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import type { HiggsfieldProbe } from '../src/higgsfield.js';
import { homePaths } from '../src/home.js';
import type { McpServerRow, SkillDetail } from '../src/index.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noHiggsfield: HiggsfieldProbe = {
  exec: async () => ({ exitCode: 127, stdout: '', stderr: 'not found' }),
  mcp: async () => 'unreachable',
  login: async () => ({ started: false }),
};

async function setup(o: { listen?: boolean; localPeer?: (a: string | undefined) => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cust-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
  const daemon = new Daemon({
    home,
    store: new MemoryEventStore(),
    channels: [],
    env: { SHIBAOX_DAEMON_TOKEN: 'secret-1', PATH: process.env.PATH, HOME: dir },
    log: () => {},
    version: '9.9.9',
    vault: join(dir, 'vault'),
    discovery: false,
    claudeInstalled: false,
    higgsfield: noHiggsfield,
    ...(o.localPeer ? { localPeer: o.localPeer } : {}),
    ...(o.listen
      ? {
          config: {
            max_concurrent_runs: 2,
            approval_timeout_minutes: 1,
            channels: { macos: { enabled: false } },
            listen: { host: '127.0.0.1', port: 0, token_env: 'SHIBAOX_DAEMON_TOKEN' },
          } as never,
        }
      : {}),
  });
  daemons.push(daemon);
  await daemon.start();
  const client = new DaemonClient(home.socket);
  const remote = o.listen
    ? new DaemonClient({
        baseUrl: `http://127.0.0.1:${daemon.listenAddress()?.port}`,
        token: 'secret-1',
      })
    : undefined;
  return { dir, org: join(dir, 'org'), client, remote };
}

function bareRepo(files: Record<string, string>): string {
  const work = mkdtempSync(join(tmpdir(), 'cust-work-'));
  tmp.push(work);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(work, rel, '..'), { recursive: true });
    writeFileSync(join(work, rel), content);
  }
  const g = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd: work,
      stdio: 'pipe',
    });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('commit', '-q', '-m', 'x');
  const bare = join(work, '..', `${work.split('/').pop()}.git`);
  tmp.push(bare);
  execFileSync('git', ['clone', '-q', '--bare', work, bare], { stdio: 'pipe' });
  return `file://${bare}`;
}

describe('customize API', () => {
  it('skills: list, add (inline + repo), discover, delete with and without detach', async () => {
    const { org, client } = await setup();
    expect((await client.skills(org)).map((s) => s.id)).toEqual(['higgsfield', 'higgsfield-app']);
    expect(await client.addSkills(org, { source: 'builtin', id: 'higgsfield-app' })).toEqual({
      added: [],
      skipped: [{ id: 'higgsfield-app', reason: 'exists' }],
    });
    const rewritten = await client.addSkills(org, {
      source: 'builtin',
      id: 'higgsfield-app',
      replace: true,
    });
    expect(rewritten.added.map((s) => s.id)).toEqual(['higgsfield-app']);
    await expect(client.addSkills(org, { source: 'builtin', id: 'ghost' })).rejects.toMatchObject({
      status: 404,
    });
    const inline = await client.addSkills(org, {
      source: 'inline',
      id: 'notes',
      content: '---\nname: Notes\ndescription: Take notes\n---\n\nBody.\n',
    });
    expect(inline.added).toMatchObject([{ id: 'notes', name: 'Notes', roles: [] }]);
    const url = bareRepo({ 'skills/pdf/SKILL.md': '# PDF\n\nRead PDFs.\n' });
    const found = await client.discoverSkills(url, 'skills');
    expect(found).toEqual({
      repo: url,
      skills: [{ id: 'pdf', name: 'pdf', description: 'Read PDFs.', path: 'skills/pdf' }],
    });
    const fromRepo = await client.addSkills(org, { source: 'repo', repo: url, path: 'skills' });
    expect(fromRepo.added.map((s) => s.id)).toEqual(['pdf']);
    const err = await client.removeSkill(org, 'higgsfield').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonHttpError);
    expect((err as DaemonHttpError).status).toBe(409);
    expect((err as DaemonHttpError).details?.roles).toEqual(['assistant']);
    expect(await client.removeSkill(org, 'higgsfield', { detach: true })).toEqual({
      removed: true,
    });
    await expect(client.removeSkill(org, 'higgsfield')).rejects.toMatchObject({ status: 404 });
    await expect(
      client.addSkills(org, { source: 'repo', repo: 'not a repo' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('roles and mcp: list, put (400 on unknown ids), add (409, replace), delete detaches', async () => {
    const { org, client } = await setup();
    const roles = await client.roles(org);
    expect(roles.find((r) => r.id === 'assistant')).toMatchObject({ mcp: ['higgsfield'] });
    const put = await client.putRole(org, 'assistant', { mcp: ['higgsfield', 'playwright'] });
    expect(put.mcp).toEqual(['higgsfield', 'playwright']);
    await expect(client.putRole(org, 'assistant', { skills: ['ghost'] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.putRole(org, 'ghost', { mcp: [] })).rejects.toMatchObject({
      status: 404,
    });
    const added = await client.addMcp(org, {
      id: 'fetch',
      description: 'Fetch',
      server: { transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
      roles: ['backend'],
    });
    expect(added).toMatchObject({
      id: 'fetch',
      roles: ['backend'],
      target: 'uvx mcp-server-fetch',
    });
    await expect(
      client.addMcp(org, {
        id: 'fetch',
        description: 'x',
        server: { transport: 'stdio', command: 'x' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await client.addMcp(org, {
          id: 'fetch',
          description: 'Fetch 2',
          server: { transport: 'stdio', command: 'x' },
          replace: true,
        })
      ).description,
    ).toBe('Fetch 2');
    expect(await client.removeMcp(org, 'playwright')).toEqual({ removed: true });
    expect((await client.roles(org)).find((r) => r.id === 'assistant')?.mcp).toEqual([
      'higgsfield',
    ]);
    expect((await client.mcpList(org)).map((r) => r.id)).toEqual(['fetch', 'higgsfield']);
    // the test route still answers
    await expect(client.mcpTest('nope', org)).rejects.toMatchObject({ status: 404 });
  });

  it('registries and plugins', async () => {
    const { client } = await setup();
    const connectors = await client.connectorRegistry();
    expect(connectors.find((c) => c.id === 'github')?.server.transport).toBe('http');
    expect((await client.skillSources())[0]?.repo).toBe('anthropics/skills');
    const plugins = await client.plugins();
    expect(plugins.map((p) => p.id)).toEqual(['higgsfield', 'github', 'telegram', 'typesafe']);
    expect(plugins[0]?.status).toBe('off');
  });

  it('a loopback client of the network listener may write', async () => {
    const { org, remote } = await setup({ listen: true });
    const r = await remote?.addSkills(org, { source: 'inline', id: 'n', content: '# N\n\nx\n' });
    expect(r?.added[0]?.id).toBe('n');
  });

  it('network callers from another machine are refused every org write', async () => {
    const { org, remote, dir } = await setup({ listen: true, localPeer: () => false });
    const c = remote as DaemonClient;
    expect((await c.skills(org)).length).toBe(2); // reads are fine
    const forbidden = { status: 403 };
    await expect(
      c.addSkills(org, { source: 'inline', id: 'n', content: 'x' }),
    ).rejects.toMatchObject(forbidden);
    await expect(c.addSkills(org, { source: 'folder', path: dir })).rejects.toMatchObject(
      forbidden,
    );
    await expect(c.removeSkill(org, 'higgsfield', { detach: true })).rejects.toMatchObject(
      forbidden,
    );
    await expect(c.putRole(org, 'assistant', { mcp: [] })).rejects.toMatchObject(forbidden);
    await expect(
      c.addMcp(org, { id: 'x', description: 'x', server: { transport: 'stdio', command: 'x' } }),
    ).rejects.toMatchObject(forbidden);
    await expect(c.removeMcp(org, 'playwright')).rejects.toMatchObject(forbidden);
    // a file:// repository is only for callers on this machine
    await expect(c.discoverSkills('file:///etc')).rejects.toMatchObject({ status: 400 });
    expect(existsSync(join(org, 'skills/higgsfield'))).toBe(true);
    expect(existsSync(join(org, 'catalog/playwright.yaml'))).toBe(true);
  });
});

describe('customize API hardening', () => {
  it('refuses org writes carrying forwarded headers even from loopback (a reverse proxy)', async () => {
    const { org, remote } = await setup({ listen: true });
    const base = (remote as unknown as { remote: { url: URL } }).remote.url.origin;
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/skills?org=${encodeURIComponent(org)}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-1',
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({ source: 'inline', id: 'n', content: '# N\n\nx\n' }),
      });
    expect((await post({ 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    expect((await post({ forwarded: 'for=203.0.113.9' })).status).toBe(403);
    const cfg = await fetch(`${base}/orgs/config?org=${encodeURIComponent(org)}`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer secret-1',
        'content-type': 'application/json',
        'x-forwarded-for': '203.0.113.9',
      },
      body: JSON.stringify({}),
    });
    expect(cfg.status).toBe(403);
    expect(existsSync(join(org, 'skills/n'))).toBe(false);
  });

  it('PUT /orgs/config is refused to callers from another machine', async () => {
    const { org, remote } = await setup({ listen: true, localPeer: () => false });
    await expect((remote as DaemonClient).setOrgConfig(org, {})).rejects.toMatchObject({
      status: 403,
    });
    expect((await (remote as DaemonClient).orgConfig(org)).tiers).toBeTruthy();
  });

  it('a network caller may not POST a file:// repository', async () => {
    const { org, remote } = await setup({ listen: true });
    const url = bareRepo({ 'a/SKILL.md': '# A\n\nA.\n' });
    // loopback is local: allowed
    expect(
      (await (remote as DaemonClient).addSkills(org, { source: 'repo', repo: url })).added,
    ).toHaveLength(1);
    const far = await setup({ listen: true, localPeer: () => false });
    await expect(
      (far.remote as DaemonClient).addSkills(far.org, { source: 'repo', repo: url }),
    ).rejects.toMatchObject({ status: 403 });
    await expect((far.remote as DaemonClient).discoverSkills(url)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('DELETE /mcp of an entry that is not an mcp server is a 404; PUT /roles with a server-less mcp entry is a 400', async () => {
    const { org, client } = await setup();
    writeFileSync(join(org, 'catalog/tooly.yaml'), 'id: tooly\ntype: tool\ndescription: T\n');
    writeFileSync(join(org, 'catalog/marker.yaml'), 'id: marker\ntype: mcp\ndescription: M\n');
    await expect(client.removeMcp(org, 'tooly')).rejects.toMatchObject({ status: 404 });
    await expect(client.putRole(org, 'assistant', { mcp: ['marker'] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.putRole(org, 'assistant', { mcp: ['toString'] })).rejects.toMatchObject({
      status: 400,
    });
    await expect(client.putRole(org, 'toString', { mcp: [] })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('an unknown error in a write route is a 500, not a 400', async () => {
    const { org, client } = await setup();
    // a role file that does not parse makes loadOrg throw a plain Error
    writeFileSync(join(org, 'roles/broken.yaml'), 'role: [unclosed\n');
    const err = await client.putRole(org, 'assistant', { mcp: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonHttpError);
    expect((err as DaemonHttpError).status).toBe(500);
  });

  it('GET /skills/:id answers the skill with its SKILL.md text; 404 unknown', async () => {
    const { org, client } = await setup();
    const one: SkillDetail = await client.skill(org, 'higgsfield');
    expect(one).toMatchObject({ id: 'higgsfield', roles: ['assistant'] });
    expect(one.content).toBe(readFileSync(join(org, 'skills/higgsfield/SKILL.md'), 'utf8'));
    await expect(client.skill(org, 'nope')).rejects.toMatchObject({ status: 404 });
    // discover is still its own route
    await expect(client.discoverSkills('')).rejects.toMatchObject({ status: 400 });
  });

  it('GET /mcp rows carry the raw server', async () => {
    const { org, client } = await setup();
    const rows: McpServerRow[] = await client.mcpList(org);
    expect(rows.find((r) => r.id === 'higgsfield')?.server?.transport).toBe('http');
  });

  it('POST /mcp refuses a key value where a key name goes, pointing to Keys', async () => {
    const { org, client } = await setup();
    let err: unknown;
    try {
      await client.addMcp(org, {
        id: 'acme',
        description: 'x',
        server: { transport: 'http', url: 'https://e.com/mcp', env_keys: ['f676-0db0:4cca224bee'] },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DaemonHttpError);
    expect((err as DaemonHttpError).status).toBe(400);
    expect((err as DaemonHttpError).code).toBe('bad_key_name');
    expect((err as DaemonHttpError).message).toMatch(/Customize → Keys/);
    expect((err as DaemonHttpError).message).not.toMatch(/4cca224bee/);
  });
});
