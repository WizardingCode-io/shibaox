import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type Bridge, startBridge } from '../src/bridge.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in daemon on a Unix socket: /health, an echo of headers, and an SSE stream. */
async function fakeDaemon(): Promise<{ socketPath: string; server: Server; seen: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'shx-br-'));
  const socketPath = join(dir, 'd.sock');
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(
      `${req.method} ${req.url} auth=${req.headers.authorization ?? '-'} host=${req.headers.host ?? '-'}`,
    );
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: 'test' }));
    }
    if (req.url?.startsWith('/runs/r1/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      setTimeout(() => {
        res.write('data: {"n":2}\n\n');
        res.end();
      }, 50);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ got: JSON.parse(body) }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(socketPath, r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { socketPath, server, seen };
}

async function bridgeFor(socketPath: string, dist?: string): Promise<Bridge> {
  const b = await startBridge({ socketPath, dist });
  cleanups.push(() => b.close());
  return b;
}
const baseOf = (b: Bridge) => b.url.split('/app/')[0] as string;

describe('startBridge', () => {
  it('serves the app without a token and forwards the API only with the bridge token', async () => {
    const { socketPath, seen } = await fakeDaemon();
    const dist = mkdtempSync(join(tmpdir(), 'shx-bd-'));
    writeFileSync(join(dist, 'index.html'), '<title>Shibaox</title>');
    const b = await bridgeFor(socketPath, dist);
    expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app\/#token=[0-9a-f]{48}$/);
    const base = baseOf(b);
    expect((await fetch(`${base}/app/`)).status).toBe(200);
    expect((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location')).toBe('/app/');
    const anon = await fetch(`${base}/health`);
    expect(anon.status).toBe(401);
    expect((await anon.json()).error.code).toBe('unauthorized');
    expect(
      (await fetch(`${base}/health`, { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    const ok = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${b.token}` } });
    expect(await ok.json()).toEqual({ version: 'test' });
    // the daemon never sees the bridge token nor the browser's host header (Node's default only)
    expect(seen).toEqual(['GET /health auth=- host=localhost']);
  });

  it('forwards request bodies and streams server-sent events as they arrive', async () => {
    const { socketPath } = await fakeDaemon();
    const b = await bridgeFor(socketPath);
    const base = baseOf(b);
    const headers = { authorization: `Bearer ${b.token}`, 'content-type': 'application/json' };
    const posted = await fetch(`${base}/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ a: 1 }),
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual({ got: { a: 1 } });
    const t0 = Date.now();
    const r = await fetch(`${base}/runs/r1/events`, { headers });
    expect(r.headers.get('content-type')).toBe('text/event-stream');
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    const firstAt = Date.now() - t0;
    expect(new TextDecoder().decode(first.value)).toContain('{"n":1}');
    expect(firstAt).toBeLessThan(45);
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('{"n":2}');
  });

  it('answers 502 when nothing listens on the socket, and close() drops open connections', async () => {
    const b = await bridgeFor(join(mkdtempSync(join(tmpdir(), 'shx-dead-')), 'none.sock'));
    const r = await fetch(`${baseOf(b)}/health`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(r.status).toBe(502);
    expect((await r.json()).error.code).toBe('daemon_unavailable');
    await b.close();
    await expect(fetch(`${baseOf(b)}/app/`)).rejects.toThrow();
  });

  it('takes a fixed port and a token of the caller', async () => {
    const { socketPath } = await fakeDaemon();
    const probe = await startBridge({ socketPath, dist: undefined });
    const port = probe.port;
    await probe.close();
    const b = await startBridge({ socketPath, dist: undefined, port, token: 'tok' });
    cleanups.push(() => b.close());
    expect(b.port).toBe(port);
    expect(b.url).toBe(`http://127.0.0.1:${port}/app/#token=tok`);
    await expect(startBridge({ socketPath, dist: undefined, port })).rejects.toThrow(/EADDRINUSE/);
  });
});
