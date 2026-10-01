import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonHttpError } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import type { HiggsfieldProbe } from '../src/higgsfield.js';
import { homePaths } from '../src/home.js';
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
    expect((await client.skills(org)).map((s) => s.id)).toEqual(['higgsfield']);
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
    expect((await c.skills(org)).length).toBe(1); // reads are fine
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
