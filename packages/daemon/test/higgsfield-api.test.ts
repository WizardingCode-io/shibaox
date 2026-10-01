import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apiBase,
  apiValidity,
  defaultHiggsfieldProbe,
  effectiveHiggsfieldMode,
  HIGGSFIELD_API,
  higgsfieldApiCheck,
  PROBE_REQUEST_ID,
  runtimeHiggsfieldMode,
} from '../src/higgsfield.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

async function serve(status: number) {
  const seen: { url?: string; auth?: string; method?: string }[] = [];
  const s = createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, method: req.method });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end('{"detail":"x"}');
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

describe('Higgsfield API: validity and modes', () => {
  it('apiValidity: 401/403 refuse the key, 404 means it was accepted, anything else is unknown', () => {
    expect(apiValidity(401)).toBe(false);
    expect(apiValidity(403)).toBe(false);
    expect(apiValidity(404)).toBe(true);
    expect(apiValidity(500)).toBe('unknown');
    expect(apiValidity(200)).toBe('unknown');
    expect(apiValidity(302)).toBe('unknown');
  });

  it('apiBase: the public API unless SHIBAOX_HIGGSFIELD_API_BASE overrides it', () => {
    expect(HIGGSFIELD_API).toBe('https://api.higgsfield.ai');
    expect(apiBase({})).toBe(HIGGSFIELD_API);
    expect(apiBase({ SHIBAOX_HIGGSFIELD_API_BASE: 'http://127.0.0.1:9/' })).toBe(
      'http://127.0.0.1:9',
    );
    expect(PROBE_REQUEST_ID).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('effectiveHiggsfieldMode: what generates now', () => {
    const t = (keySet: boolean, loggedIn: boolean) => ({ keySet, loggedIn });
    expect(effectiveHiggsfieldMode('auto', t(true, true))).toBe('api');
    expect(effectiveHiggsfieldMode('auto', t(false, true))).toBe('account');
    expect(effectiveHiggsfieldMode('auto', t(false, false))).toBe('none');
    expect(effectiveHiggsfieldMode('api', t(false, true))).toBe('none');
    expect(effectiveHiggsfieldMode('api', t(true, false))).toBe('api');
    expect(effectiveHiggsfieldMode('account', t(true, true))).toBe('account');
    expect(effectiveHiggsfieldMode('account', t(true, false))).toBe('none');
  });

  it('runtimeHiggsfieldMode: what a task is given (never none)', () => {
    expect(runtimeHiggsfieldMode('auto', true)).toBe('api');
    expect(runtimeHiggsfieldMode('auto', false)).toBe('account');
    expect(runtimeHiggsfieldMode('api', false)).toBe('api');
    expect(runtimeHiggsfieldMode('account', true)).toBe('account');
  });
});

describe('the API key probe', () => {
  it('GETs the zero request status with Authorization: Key <key>; 404 is a valid key', async () => {
    const { base, seen } = await serve(404);
    expect(await higgsfieldApiCheck('id:secret', base)).toEqual({ valid: true, status: 404 });
    expect(seen).toEqual([
      { url: `/requests/${PROBE_REQUEST_ID}/status`, auth: 'Key id:secret', method: 'GET' },
    ]);
  });
  it('401 is a refused key, 500 is unknown, a refused connection is unknown', async () => {
    expect(await higgsfieldApiCheck('id:secret', (await serve(401)).base)).toEqual({
      valid: false,
      status: 401,
    });
    expect(await higgsfieldApiCheck('id:secret', (await serve(500)).base)).toEqual({
      status: 500,
    });
    const dead = await serve(404);
    const s = servers.pop();
    await new Promise((r) => s?.close(r));
    expect(await higgsfieldApiCheck('id:secret', dead.base)).toEqual({});
  });
  it('the default probe uses the base from the environment', async () => {
    const { base, seen } = await serve(401);
    const probe = defaultHiggsfieldProbe({ SHIBAOX_HIGGSFIELD_API_BASE: base });
    expect(await probe.apiCheck?.('a:b')).toEqual({ valid: false, status: 401 });
    expect(seen[0]?.auth).toBe('Key a:b');
  });
});
