import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MISSING, serveAppFile } from '../src/app-static.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A request with the path sent as is: `fetch` would normalise `..` away before sending. */
function rawGet(base: string, path: string): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(dist: string | undefined): Promise<string> {
  const server = createServer((req, res) => serveAppFile(dist, req.url ?? '/', res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
}

function fakeDist(): string {
  const parent = mkdtempSync(join(tmpdir(), 'shx-dist-'));
  dirs.push(parent);
  const dist = join(parent, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Shibaox</title>');
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dist, 'assets', 'app-abc123.css'), 'body{}');
  writeFileSync(join(dist, 'manifest.webmanifest'), '{}');
  writeFileSync(join(dist, '..', 'secret.txt'), 'nope');
  return dist;
}

describe('serveAppFile', () => {
  it('serves the index for /app, /app/ and the app routes (no extension), never cached', async () => {
    const base = await serve(fakeDist());
    for (const p of ['/app', '/app/', '/app/chats', '/app/t/run-1']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(await r.text()).toContain('Shibaox');
    }
  });

  it('serves the hashed assets with their content type, cached for a year', async () => {
    const base = await serve(fakeDist());
    const js = await fetch(`${base}/app/assets/app-abc123.js`);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const css = await fetch(`${base}/app/assets/app-abc123.css`);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    const manifest = await fetch(`${base}/app/manifest.webmanifest`);
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json');
    expect(manifest.headers.get('cache-control')).toBe('no-cache');
  });

  it('a missing file with an extension is a JSON 404, and paths never leave the dist', async () => {
    const base = await serve(fakeDist());
    const missing = await fetch(`${base}/app/assets/nope.js`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('not_found');
    for (const p of [
      '/app/../secret.txt',
      '/app/%2e%2e/secret.txt',
      '/app/..%2fsecret.txt',
      '/app/assets/../../secret.txt',
    ]) {
      const r = await rawGet(base, p);
      expect(r.status, p).toBe(404);
      expect(r.body, p).not.toContain('nope');
    }
  });

  it('without a dist, says how to install the app', async () => {
    const base = await serve(undefined);
    const r = await fetch(`${base}/app/`);
    expect(r.status).toBe(404);
    expect((await r.json()).error.message).toBe(APP_MISSING);
  });
});
