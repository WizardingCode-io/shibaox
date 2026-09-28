import { createServer, type Server } from 'node:http';
import { hostAllowed } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchText } from '../src/web.js';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

describe('hostAllowed', () => {
  it('matches * and hostname suffixes only', () => {
    expect(hostAllowed('api.github.com', ['*'])).toBe(true);
    expect(hostAllowed('api.github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['github.com'])).toBe(false);
    expect(hostAllowed('GitHub.com', ['github.com'])).toBe(true);
    expect(hostAllowed('github.com', [])).toBe(false);
  });
});

describe('fetchText', () => {
  it('returns the page as text with scripts, styles and tags removed', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<html><head><style>b{}</style></head><body><h1>Hi</h1><script>x()</script><p>there  now</p></body></html>',
      );
    });
    const r = await fetchText(`${base}/page`, { timeoutMs: 2000, maxBytes: 10_000, allow: ['*'] });
    expect(r.status).toBe(200);
    expect(r.text).toBe('Hi\nthere now');
  });
  it('refuses a host outside the allowlist, also after a redirect', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/go') {
        res.statusCode = 302;
        res.setHeader('location', 'http://example.com/x');
        return res.end();
      }
      res.end('ok');
    });
    await expect(
      fetchText('http://example.com/', { timeoutMs: 2000, maxBytes: 100, allow: ['127.0.0.1'] }),
    ).rejects.toThrow(/host "example.com" is not allowed/);
    await expect(
      fetchText(`${base}/go`, { timeoutMs: 2000, maxBytes: 100, allow: ['127.0.0.1'] }),
    ).rejects.toThrow(/host "example.com" is not allowed/);
  });
  it('truncates long bodies at maxBytes and only accepts http(s)', async () => {
    const base = await serve((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('a'.repeat(5000));
    });
    const r = await fetchText(`${base}/big`, { timeoutMs: 2000, maxBytes: 100, allow: ['*'] });
    expect(r.text.length).toBe(100);
    expect(r.truncated).toBe(true);
    await expect(
      fetchText('file:///etc/passwd', { timeoutMs: 2000, maxBytes: 100, allow: ['*'] }),
    ).rejects.toThrow(/http/);
  });
});
