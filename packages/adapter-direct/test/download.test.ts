import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveApprovals } from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTools } from '../src/tools.js';

const server = createServer((req, res) => {
  if (req.url === '/cat.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  } else if (req.url === '/hop') {
    res.writeHead(302, {
      location: `http://127.0.0.1:${(server.address() as { port: number }).port}/cat.png`,
    });
    res.end();
  } else if (req.url === '/big.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(5000, 1));
  } else {
    res.writeHead(404);
    res.end();
  }
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const args = (ws: string, role: Record<string, unknown>) => ({
  workspace: ws,
  role: RoleSchema.parse({ role: 'r', ...role }),
  runId: 'r',
  nodeId: 'n',
  ctx: { signal: new AbortController().signal, log: () => {} },
  emit: () => {},
  onFinish: () => {},
  approvals: new AutoApproveApprovals(),
  approvedCommands: {},
  onSuspend: () => {},
  commandTimeoutMs: 1000,
  maxFileBytes: 1000,
  maxDownloadBytes: 4000,
  downloadAllowHttp: true,
  extraTools: [],
});
const build = (ws: string, role: Record<string, unknown>) => buildTools(args(ws, role));

describe('download_file', () => {
  it('exists for writing roles with a network allowlist, saves the bytes under the workspace, reports the mime', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dl-'));
    expect(Object.keys(build(ws, { tools: ['write'] }))).not.toContain('download_file');
    expect(
      Object.keys(build(ws, { tools: [], permissions: { network: ['127.0.0.1'] } })),
    ).not.toContain('download_file');
    const t = build(ws, { tools: ['write'], permissions: { network: ['127.0.0.1'] } });
    const r = (await t.download_file?.execute?.(
      { url: `${base}/cat.png`, path: 'outputs/cat.png' },
      { toolCallId: 'x', messages: [] },
    )) as { ok: boolean; path: string; bytes: number; mime?: string };
    expect(r).toMatchObject({ ok: true, path: 'outputs/cat.png', bytes: 7, mime: 'image/png' });
    expect(readFileSync(join(ws, 'outputs/cat.png'))[1]).toBe(0x50);
  });
  it('refuses other hosts, paths outside the workspace, and files past the cap', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'dl-'));
    const t = build(ws, { tools: ['write'], permissions: { network: ['127.0.0.1'] } });
    const run = (url: string, path: string) =>
      t.download_file?.execute?.({ url, path }, { toolCallId: 'x', messages: [] }) as Promise<{
        error?: string;
      }>;
    expect((await run('https://example.com/x.png', 'x.png')).error).toMatch(/not allowed/);
    expect((await run(`${base}/cat.png`, '../x.png')).error).toMatch(/workspace|outside/i);
    expect((await run(`${base}/big.bin`, 'big.bin')).error).toMatch(/cap|larger/);
    // a redirect never escapes the rule: every hop must be https (the test server allows plain http only because it asked)
    const strict = buildTools({
      ...args(ws, { tools: ['write'], permissions: { network: ['127.0.0.1'] } }),
      downloadAllowHttp: false,
    });
    const hop = (await strict.download_file?.execute?.(
      { url: `${base}/hop`, path: 'hop.png' },
      { toolCallId: 'x', messages: [] },
    )) as { error?: string };
    expect(hop.error).toMatch(/https/);
    expect(existsSync(join(ws, 'big.bin'))).toBe(false);
  });
});
