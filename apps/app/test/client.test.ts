import { describe, expect, it } from 'vitest';
import { AppClient, AppHttpError } from '../src/api/client.js';
import { clearConnection, readConnection, saveConnection } from '../src/api/connection.js';

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AppClient', () => {
  it('sends the bearer token, parses JSON, and turns HTTP errors into AppHttpError', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('/runs?thread=t1')
        ? json([{ runId: 'r1' }])
        : url.endsWith('/runs/nope')
          ? json({ error: { code: 'not_found', message: 'run nope not found' } }, 404)
          : json({ version: '0.2.1' }),
    );
    const c = new AppClient('http://127.0.0.1:7433/', 'tok', { fetch: f.fetch });
    expect(await c.health()).toEqual({ version: '0.2.1' });
    expect(f.calls[0]?.url).toBe('http://127.0.0.1:7433/health');
    expect(new Headers(f.calls[0]?.init.headers).get('authorization')).toBe('Bearer tok');
    expect(await c.listRuns({ thread: 't1' })).toEqual([{ runId: 'r1' }]);
    await expect(c.getRun('nope')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(c.getRun('nope')).rejects.toBeInstanceOf(AppHttpError);
  });
  it('posts a run, a turn answer, a steer and a cancel to the daemon paths', async () => {
    const f = fakeFetch(() => json({ ok: true }));
    const c = new AppClient('http://d', undefined, { fetch: f.fetch });
    await c.submitRun({
      orgRoot: '/o',
      project: '/p',
      workflow: 'chat',
      input: 'hi',
      thread: 'root',
    } as never);
    await c.answer('approval:1', { approved: true, note: 'go' });
    await c.steer('r1', { note: 'the other way' });
    await c.cancel('r1');
    await c.resume('r1', { budgetUsd: 2 });
    expect(f.calls.map((x) => [x.init.method, x.url.replace('http://d', '')])).toEqual([
      ['POST', '/runs'],
      ['POST', '/inbox/approval%3A1'],
      ['POST', '/runs/r1/steer'],
      ['POST', '/runs/r1/cancel'],
      ['POST', '/runs/r1/resume'],
    ]);
    expect(JSON.parse(String(f.calls[1]?.init.body))).toEqual({
      via: 'api',
      approved: true,
      note: 'go',
    });
    expect(JSON.parse(String(f.calls[2]?.init.body))).toEqual({
      note: 'the other way',
      via: 'api',
    });
    expect(new Headers(f.calls[0]?.init.headers).has('authorization')).toBe(false);
  });
  it('streams the run events as SSE frames over fetch, with the cursor, until the end frame', async () => {
    const frames = [
      'data: {"kind":"run","seq":1,"cursor":"1:0","event":{"type":"RunStarted"}}\n\n',
      ': heartbeat\n\n',
      'data: {"kind":"runtime","seq":2,"cursor":"1:1","event":{"type":"text","text":"hi"}}\n\ndata: {"kind":"end","seq":3,"cursor":"1:1","status":"completed"}\n\n',
      'data: {"kind":"run","seq":9,"cursor":"9:0","event":{"type":"never"}}\n\n',
    ];
    const f = fakeFetch(
      () =>
        new Response(
          new ReadableStream({
            start(ctl) {
              for (const fr of frames) ctl.enqueue(new TextEncoder().encode(fr));
              ctl.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const c = new AppClient('http://d', 'tok', { fetch: f.fetch });
    const seen: string[] = [];
    for await (const e of c.stream('r1', { since: '1:0' })) seen.push(e.kind);
    expect(seen).toEqual(['run', 'runtime', 'end']);
    expect(f.calls[0]?.url).toBe('http://d/runs/r1/events?since=1%3A0');
    const bad = fakeFetch(() => json({ error: { code: 'not_found', message: 'no run' } }, 404));
    const c2 = new AppClient('http://d', 'tok', { fetch: bad.fetch });
    await expect(
      (async () => {
        for await (const _ of c2.stream('x')) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('the connection', () => {
  const storage = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  };
  it('reads the token off the URL fragment once, remembers it, and strips it from the address bar', () => {
    const s = storage();
    const replaced: string[] = [];
    const conn = readConnection({
      location: {
        origin: 'http://127.0.0.1:7433',
        pathname: '/app/',
        search: '',
        hash: '#token=abc123',
      },
      storage: s,
      replaceUrl: (u) => replaced.push(u),
    });
    expect(conn).toEqual({ base: 'http://127.0.0.1:7433', token: 'abc123' });
    expect(replaced).toEqual(['/app/']);
    expect(
      readConnection({
        location: { origin: 'http://127.0.0.1:7433', pathname: '/app/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toEqual(conn);
  });
  it('a route in the hash survives; without a token there is no connection; save and clear', () => {
    const s = storage();
    const replaced: string[] = [];
    const conn = readConnection({
      location: { origin: 'http://h', pathname: '/app/', search: '', hash: '#/t/r1&token=zzz' },
      storage: s,
      replaceUrl: (u) => replaced.push(u),
    });
    expect(conn?.token).toBe('zzz');
    expect(replaced).toEqual(['/app/#/t/r1']);
    clearConnection(s);
    expect(
      readConnection({
        location: { origin: 'http://h', pathname: '/app/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toBeUndefined();
    saveConnection(s, { base: 'https://vps:7433', token: 't' });
    expect(
      readConnection({
        location: { origin: 'http://h', pathname: '/', search: '', hash: '' },
        storage: s,
        replaceUrl: () => {},
      }),
    ).toEqual({ base: 'https://vps:7433', token: 't' });
  });
});
