import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient } from '../src/client.js';
import { Daemon } from '../src/daemon.js';
import { homePaths } from '../src/home.js';
import { listRunFiles, RunFileError, readRunFile } from '../src/runs/files.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop({ force: true }).catch(() => undefined);
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'files-'));
  tmp.push(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'package.json'), '{"name":"p","scripts":{"test":"node -e 0"}}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return dir;
}

describe('readRunFile', () => {
  it('reads a text file inside the workspace, with its size', async () => {
    const dir = repo();
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'out', 'clientes.csv'), 'name,age\nAna,37\n');
    const f = await readRunFile(dir, 'out/clientes.csv');
    expect(f).toMatchObject({
      path: 'out/clientes.csv',
      size: 16,
      encoding: 'utf8',
      content: 'name,age\nAna,37\n',
      truncated: false,
    });
  });

  it('never leaves the workspace: dotdot, absolute paths and symlinks out are refused', async () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
    tmp.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'nope');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    for (const p of ['../secret.txt', join(outside, 'secret.txt'), 'link.txt', 'out/../../x']) {
      await expect(readRunFile(dir, p)).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(readRunFile(dir, 'missing.txt')).rejects.toMatchObject({ code: 'not_found' });
    await expect(readRunFile(join(dir, 'gone'), 'a.ts')).rejects.toMatchObject({
      code: 'no_workspace',
    });
    expect(new RunFileError('forbidden', 'x').status).toBe(403);
  });

  it('binary files come back base64, huge ones truncated', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    const b = await readRunFile(dir, 'pic.png');
    expect(b.encoding).toBe('base64');
    expect(Buffer.from(b.content, 'base64')[0]).toBe(0x89);
    expect(b.mime).toBe('image/png');
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(5000));
    const t = await readRunFile(dir, 'big.txt', { maxBytes: 1000 });
    expect(t.truncated).toBe(true);
    expect(t.content.length).toBe(1000);
    expect(t.size).toBe(5000);
  });
});

describe('listRunFiles', () => {
  it('merges the diff with the files the run reported, with sizes, sorted', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(dir, 'new.md'), '# hi\n');
    const files = await listRunFiles(
      dir,
      {
        base: 'HEAD',
        patch: '',
        truncated: false,
        files: [
          { path: 'a.ts', status: 'modified', additions: 1, deletions: 1 },
          { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 3 },
        ],
      },
      ['new.md', 'a.ts'],
    );
    expect(files).toEqual([
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 1, size: 20 },
      { path: 'gone.ts', status: 'deleted', additions: 0, deletions: 3 },
      { path: 'new.md', status: 'added', size: 5 },
    ]);
  });
});

describe('GET /runs/:id/files', () => {
  it('lists and serves the files of a run through the client; downloads as an attachment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'files-srv-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const project = repo();
    const home = homePaths({ SHIBAOX_HOME: join(dir, 'home') });
    const daemon = new Daemon({
      discovery: false,
      home,
      store: new MemoryEventStore(),
      channels: [],
      env: {},
      log: () => {},
      version: '9.9.9',
      vault: join(dir, 'vault'),
    });
    daemons.push(daemon);
    await daemon.start();
    const client = new DaemonClient(home.socket);
    const { runId } = await client.submitRun({
      orgRoot: join(dir, 'org'),
      project,
      workflow: 'hello-feature',
      input: 'add /health',
      adapter: 'mock',
      workspace: 'inplace',
    });
    for (let i = 0; i < 100; i++) {
      const s = await client.getRun(runId);
      if (s.status === 'completed' || s.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    writeFileSync(join(project, 'report.md'), '# Report\n');
    const list = await client.files(runId);
    expect(list.files.map((f) => `${f.status} ${f.path}`)).toContain('added report.md');
    const file = await client.fileContent(runId, 'report.md');
    expect(file).toMatchObject({ path: 'report.md', content: '# Report\n', encoding: 'utf8' });
    await expect(client.fileContent(runId, '../x')).rejects.toMatchObject({ status: 403 });
    await expect(client.fileContent(runId, 'nope.md')).rejects.toMatchObject({ status: 404 });
    const raw = await client.fetchRaw(
      `/runs/${encodeURIComponent(runId)}/files/content?path=report.md&download=1`,
    );
    expect(raw.headers['content-disposition']).toContain('attachment; filename="report.md"');
    expect(raw.body).toBe('# Report\n');
  });
});
