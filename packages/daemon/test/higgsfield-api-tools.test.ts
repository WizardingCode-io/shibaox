import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@wizardingcode/shibaox-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSleep,
  type HiggsfieldApiDeps,
  higgsfieldApiTools,
  nextDelay,
  saveInto,
  scrub,
} from '../src/runs/higgsfield-api-tools.js';

const KEY = 'kid-123:sekret-abcdef';
const BASE = 'https://api.test';
const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'hfapi-'));
  tmp.push(ws);
  mkdirSync(join(ws, 'attachments'));
  mkdirSync(join(ws, 'outputs'));
  mkdirSync(join(ws, 'src'));
  writeFileSync(join(ws, 'attachments', 'dog.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  writeFileSync(join(ws, 'attachments', 'notes.txt'), 'x');
  writeFileSync(join(ws, 'attachments', 'secret.png'), Buffer.from([1]));
  writeFileSync(join(ws, 'src', 'a.png'), Buffer.from([1]));
  writeFileSync(join(ws, '.env'), 'S=1');
  return ws;
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}
type Answer = { status: number; body?: unknown } | Error;

/** A fetch that answers from a per-call script and records what it was asked. */
function fakeFetch(script: (req: Seen, n: number) => Answer) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    };
    seen.push(req);
    const a = script(req, seen.length - 1);
    if (a instanceof Error) throw a;
    const text = typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {});
    return new Response(text, { status: a.status });
  }) as unknown as typeof fetch;
  return { f, seen };
}

function deps(o: Partial<HiggsfieldApiDeps> & { fetch: typeof fetch }) {
  let t = 0;
  const delays: number[] = [];
  const logs: string[] = [];
  const d: HiggsfieldApiDeps = {
    key: () => KEY,
    workspace: o.workspace ?? workspace(),
    protectedGlobs: ['attachments/secret.png'],
    base: BASE,
    now: () => t,
    sleep: async (ms) => {
      delays.push(ms);
      t += ms;
    },
    random: () => 0.5,
    log: (l) => logs.push(l),
    ...o,
  };
  const tools = higgsfieldApiTools(d);
  const tool = (name: string) => tools.find((x) => x.name === name) as AgentTool;
  return { tool, delays, logs, tools };
}

const submitted = { request_id: 'r-1', status_url: 'u', cancel_url: 'c' };

describe('higgsfield_api_generate', () => {
  it('submits once with Authorization: Key id:secret, polls with backoff and returns the images', async () => {
    const { f, seen } = fakeFetch((req) => {
      if (req.method === 'POST') return { status: 200, body: submitted };
      return seen.filter((s) => s.method === 'GET').length === 1
        ? { status: 200, body: { status: 'in_progress' } }
        : {
            status: 200,
            body: {
              status: 'completed',
              images: [{ url: 'https://cdn/a.png' }, { url: 'https://cdn/b.png' }],
            },
          };
    });
    const { tool, delays, tools, logs } = deps({ fetch: f });
    expect(tools.map((t) => t.name)).toEqual([
      'higgsfield_api_generate',
      'higgsfield_api_status',
      'higgsfield_api_cancel',
      'higgsfield_api_upload',
    ]);
    const r = await tool('higgsfield_api_generate').execute({
      model_path: '/higgsfield-ai/soul/standard/',
      input: { prompt: 'a shiba' },
    });
    expect(r).toEqual({
      request_id: 'r-1',
      status: 'completed',
      images: ['https://cdn/a.png', 'https://cdn/b.png'],
      audio: [],
    });
    expect(seen.filter((s) => s.method === 'POST')).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: `${BASE}/higgsfield-ai/soul/standard`,
      method: 'POST',
      body: JSON.stringify({ prompt: 'a shiba' }),
    });
    expect(seen[0]?.headers.authorization).toBe(`Key ${KEY}`);
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[1]?.url).toBe(`${BASE}/requests/r-1/status`);
    expect(delays).toEqual([2000, 3000]);
    expect(logs.join('\n')).not.toContain('sekret');
  });

  it('saves every result into outputs/ through deps.save and lists the files; a failed save is a note', async () => {
    const { f } = fakeFetch((req) =>
      req.method === 'POST'
        ? { status: 200, body: submitted }
        : {
            status: 200,
            body: {
              status: 'completed',
              images: [{ url: 'https://cdn/a.png' }, { url: 'https://cdn/b.webp?x=1' }],
              video: { url: 'https://cdn/c.mp4' },
            },
          },
    );
    const saved: { url: string; name: string }[] = [];
    const { tool } = deps({
      fetch: f,
      save: async (url, name) => {
        saved.push({ url, name });
        if (url.endsWith('c.mp4')) throw new Error('disk full https://signed.example/x?sig=1');
        return `outputs/${name}`;
      },
    });
    const r = (await tool('higgsfield_api_generate').execute({
      model_path: 'higgsfield-ai/soul/standard',
      input: { prompt: 'a shiba' },
    })) as { files?: string[]; note?: string; images: string[] };
    expect(saved.map((x) => x.name)).toEqual(['hf-r-1-1.png', 'hf-r-1-2.webp', 'hf-r-1-3.mp4']);
    expect(r.files).toEqual(['outputs/hf-r-1-1.png', 'outputs/hf-r-1-2.webp']);
    expect(r.note).toMatch(/hf-r-1-3\.mp4.*could not be saved/);
    expect(r.note).not.toMatch(/sig=1/);
    expect(r.images).toHaveLength(2);
    // status on a completed request saves too
    const st = (await tool('higgsfield_api_status').execute({ request_id: 'r-1' })) as {
      files?: string[];
    };
    expect(st.files).toEqual(['outputs/hf-r-1-1.png', 'outputs/hf-r-1-2.webp']);
  });

  it('nextDelay grows from 2 s by half up to 10 s, with ±20 % jitter', () => {
    const seq: number[] = [];
    let d: number | undefined;
    for (let i = 0; i < 7; i++) {
      d = nextDelay(d);
      seq.push(d);
    }
    expect(seq).toEqual([2000, 3000, 4500, 6750, 10000, 10000, 10000]);
    expect(nextDelay(undefined, () => 0)).toBe(1600);
    expect(nextDelay(undefined, () => 1)).toBe(2400);
  });

  it('failed, nsfw and canceled are terminal and returned as they are', async () => {
    for (const status of ['failed', 'nsfw', 'canceled']) {
      const { f } = fakeFetch((req) =>
        req.method === 'POST'
          ? { status: 200, body: submitted }
          : { status: 200, body: { status, error: status === 'failed' ? 'bad seed' : undefined } },
      );
      const r = (await deps({ fetch: f })
        .tool('higgsfield_api_generate')
        .execute({ model_path: 'a/b', input: {} })) as { status: string; error?: string };
      expect(r.status).toBe(status);
      if (status === 'failed') expect(r.error).toBe('bad seed');
    }
  });

  it('a 401 says to replace the key and never shows the secret', async () => {
    const { f } = fakeFetch(() => ({ status: 401, body: { detail: `bad key ${KEY}` } }));
    const p = deps({ fetch: f }).tool('higgsfield_api_generate').execute({
      model_path: 'a/b',
      input: {},
    });
    await expect(p).rejects.toThrow(/Higgsfield refused the API key: replace it in Customize/);
    await p.catch((e: Error) => {
      expect(e.message).not.toContain('sekret');
      expect(e.message).not.toContain(KEY);
    });
  });

  it('a 503 or a network error on submit is never retried', async () => {
    for (const answer of [{ status: 503, body: 'down' }, new Error(`socket hang up ${KEY}`)]) {
      const { f, seen } = fakeFetch(() => answer);
      const p = deps({ fetch: f }).tool('higgsfield_api_generate').execute({
        model_path: 'a/b',
        input: {},
      });
      await expect(p).rejects.toThrow(
        /may or may not exist.*do not submit it again.*ask the user/i,
      );
      await p.catch((e: Error) => expect(e.message).not.toContain('sekret'));
      expect(seen).toHaveLength(1);
    }
  });

  it('two 5xx on status are retried, then completed', async () => {
    let gets = 0;
    const { f } = fakeFetch((req) => {
      if (req.method === 'POST') return { status: 200, body: submitted };
      gets++;
      return gets <= 2
        ? { status: 502 }
        : { status: 200, body: { status: 'completed', video: { url: 'https://cdn/v.mp4' } } };
    });
    const r = await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {} });
    expect(r).toMatchObject({ status: 'completed', video: 'https://cdn/v.mp4' });
  });

  it('five 5xx in a row on status give unknown with a note, not an error', async () => {
    const { f } = fakeFetch((req) =>
      req.method === 'POST' ? { status: 200, body: submitted } : { status: 500 },
    );
    const r = (await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {} })) as { status: string; note: string };
    expect(r.status).toBe('unknown');
    expect(r.note).toMatch(/higgsfield_api_status/);
  });

  it('a persistent 429 on status gives unknown after five answers, never a cancel', async () => {
    const { f, seen } = fakeFetch((req) =>
      req.method === 'POST' ? { status: 200, body: submitted } : { status: 429 },
    );
    const r = (await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {} })) as { status: string; note: string };
    expect(r.status).toBe('unknown');
    expect(r.note).toMatch(/higgsfield_api_status/);
    expect(r.note).toMatch(/do not submit again/);
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(5);
    expect(seen.some((s) => s.url.endsWith('/cancel'))).toBe(false);
  });

  it('network failures and non-2xx answers count together toward unknown', async () => {
    let gets = 0;
    const { f, seen } = fakeFetch((req) => {
      if (req.method === 'POST') return { status: 200, body: submitted };
      gets++;
      return gets % 2 ? new Error('reset') : { status: 429 };
    });
    const r = (await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {} })) as { status: string };
    expect(r.status).toBe('unknown');
    expect(seen.filter((s) => s.method === 'GET')).toHaveLength(5);
  });

  it('a 401 in the middle of polling keeps the request id and says not to submit again', async () => {
    let gets = 0;
    const { f } = fakeFetch((req) => {
      if (req.method === 'POST') return { status: 200, body: submitted };
      return ++gets === 1
        ? { status: 200, body: { status: 'in_progress' } }
        : { status: 401, body: { detail: `bad ${KEY}` } };
    });
    const p = deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {} });
    await expect(p).rejects.toThrow(
      /request r-1 may still be running; check it with higgsfield_api_status after replacing the key \(do not submit again\)/,
    );
    await p.catch((e: Error) => expect(e.message).not.toContain('sekret'));
  });

  it('a submit aborted by a run cancel may or may not exist: do not submit again', async () => {
    const ac = new AbortController();
    const { f } = fakeFetch(() => {
      ac.abort();
      return new Error('aborted');
    });
    await expect(
      deps({ fetch: f, signal: () => ac.signal })
        .tool('higgsfield_api_generate')
        .execute({ model_path: 'a/b', input: {} }),
    ).rejects.toThrow(/cancelled.*may or may not exist.*do not submit it again/i);
  });

  it('a 404 on status is an unknown request id', async () => {
    const { f } = fakeFetch((req) =>
      req.method === 'POST' ? { status: 200, body: submitted } : { status: 404 },
    );
    await expect(
      deps({ fetch: f }).tool('higgsfield_api_generate').execute({ model_path: 'a/b', input: {} }),
    ).rejects.toThrow(/unknown request id/i);
  });

  it('past the deadline the request is cancelled (best effort): canceled_by_timeout', async () => {
    const { f, seen } = fakeFetch((req) =>
      req.method === 'POST' && req.url.endsWith('/cancel')
        ? { status: 202 }
        : req.method === 'POST'
          ? { status: 200, body: submitted }
          : { status: 200, body: { status: 'queued' } },
    );
    const r = (await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {}, timeout_s: 10 })) as { status: string };
    expect(r.status).toBe('canceled_by_timeout');
    expect(seen.at(-1)).toMatchObject({ method: 'POST', url: `${BASE}/requests/r-1/cancel` });
  });

  it('an aborted run cancels the request and rejects', async () => {
    const ac = new AbortController();
    const { f, seen } = fakeFetch((req) => {
      if (req.method === 'POST' && req.url.endsWith('/cancel')) return { status: 202 };
      if (req.method === 'POST') return { status: 200, body: submitted };
      ac.abort();
      return { status: 200, body: { status: 'in_progress' } };
    });
    await expect(
      deps({ fetch: f, signal: () => ac.signal })
        .tool('higgsfield_api_generate')
        .execute({ model_path: 'a/b', input: {} }),
    ).rejects.toThrow(/cancel/i);
    expect(seen.some((s) => s.url.endsWith('/requests/r-1/cancel'))).toBe(true);
  });

  it('wait:false returns the request id right after the submit', async () => {
    const { f, seen } = fakeFetch(() => ({
      status: 200,
      body: { ...submitted, status: 'queued' },
    }));
    const r = await deps({ fetch: f })
      .tool('higgsfield_api_generate')
      .execute({ model_path: 'a/b', input: {}, wait: false });
    expect(r).toMatchObject({ request_id: 'r-1', status: 'queued' });
    expect(seen).toHaveLength(1);
  });

  it('bad model paths are refused before any request', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 200, body: submitted }));
    const { tool } = deps({ fetch: f });
    for (const model_path of [
      'single',
      '../x/y',
      'a/../b',
      'requests/r-1/cancel',
      'files/generate-upload-url',
      'https://evil.example/a/b',
      'a/b?x=1',
      'A b/c',
    ])
      await expect(
        tool('higgsfield_api_generate').execute({ model_path, input: {} }),
      ).rejects.toThrow(/model_path/);
    expect(seen).toHaveLength(0);
  });

  it('without a key nothing is sent and the message says where to connect one', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 200, body: submitted }));
    await expect(
      deps({ fetch: f, key: () => undefined })
        .tool('higgsfield_api_generate')
        .execute({ model_path: 'a/b', input: {} }),
    ).rejects.toThrow(
      'HIGGSFIELD_API_KEY is not set: Customize → Plugins → Higgsfield → Connect API key',
    );
    expect(seen).toHaveLength(0);
  });
});

describe('higgsfield_api_status and higgsfield_api_cancel', () => {
  it('status reads once; cancel posts once', async () => {
    const { f, seen } = fakeFetch((req) =>
      req.method === 'GET'
        ? { status: 200, body: { status: 'in_progress' } }
        : { status: 202, body: {} },
    );
    const { tool } = deps({ fetch: f });
    expect(await tool('higgsfield_api_status').execute({ request_id: 'r-9' })).toMatchObject({
      request_id: 'r-9',
      status: 'in_progress',
    });
    expect(await tool('higgsfield_api_cancel').execute({ request_id: 'r-9' })).toMatchObject({
      request_id: 'r-9',
      canceled: true,
    });
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${BASE}/requests/r-9/status`,
      `POST ${BASE}/requests/r-9/cancel`,
    ]);
    await expect(tool('higgsfield_api_status').execute({ request_id: '../x' })).rejects.toThrow(
      /request_id/,
    );
  });
});

describe('higgsfield_api_upload', () => {
  it('asks for an upload URL, PUTs with exactly the returned headers and no authorization, returns the public URL', async () => {
    const uploadHeaders = { 'Content-Type': 'image/png', 'x-amz-acl': 'private' };
    const { f, seen } = fakeFetch((req) =>
      req.url.endsWith('/files/generate-upload-url')
        ? {
            status: 200,
            body: {
              upload_url: 'https://s3.test/put?X-Amz-Signature=sig',
              upload_headers: uploadHeaders,
              public_url: 'https://cdn.test/dog.png',
            },
          }
        : { status: 200 },
    );
    const { tool, logs } = deps({ fetch: f });
    const r = await tool('higgsfield_api_upload').execute({ path: 'attachments/dog.png' });
    expect(r).toEqual({
      public_url: 'https://cdn.test/dog.png',
      content_type: 'image/png',
      path: 'attachments/dog.png',
      bytes: 6,
    });
    expect(JSON.stringify(r)).not.toContain('Signature');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST ${BASE}/files/generate-upload-url`,
      'PUT https://s3.test/put?X-Amz-Signature=sig',
    ]);
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ content_type: 'image/png' });
    expect(seen[0]?.headers.authorization).toBe(`Key ${KEY}`);
    expect(seen[1]?.headers).toEqual(uploadHeaders);
    expect(Object.keys(seen[1]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain(
      'authorization',
    );
    expect(logs.join('\n')).not.toContain('Signature');
  });

  it('drops Authorization in any case from upload_headers', async () => {
    const { f, seen } = fakeFetch((req) =>
      req.url.endsWith('/files/generate-upload-url')
        ? {
            status: 200,
            body: {
              upload_url: 'https://s3.test/put?sig=1',
              upload_headers: {
                Authorization: 'Key x',
                authorization: 'Key y',
                'Content-Type': 'image/png',
              },
              public_url: 'https://cdn.test/dog.png',
            },
          }
        : { status: 200 },
    );
    await deps({ fetch: f }).tool('higgsfield_api_upload').execute({ path: 'attachments/dog.png' });
    expect(seen[1]?.headers).toEqual({ 'Content-Type': 'image/png' });
  });

  it("adds the file's content type when no returned header carries one", async () => {
    const { f, seen } = fakeFetch((req) =>
      req.url.endsWith('/files/generate-upload-url')
        ? {
            status: 200,
            body: {
              upload_url: 'https://s3.test/put?sig=1',
              upload_headers: { 'x-amz-acl': 'private' },
              public_url: 'https://cdn.test/dog.png',
            },
          }
        : { status: 200 },
    );
    await deps({ fetch: f }).tool('higgsfield_api_upload').execute({ path: 'attachments/dog.png' });
    expect(seen[1]?.headers).toEqual({ 'x-amz-acl': 'private', 'content-type': 'image/png' });
  });

  it('an upload-URL refusal never shows the key or a signed URL', async () => {
    const { f } = fakeFetch(() => ({
      status: 400,
      body: `bad request for ${KEY} at https://s3.test/put?X-Amz-Signature=sig`,
    }));
    const p = deps({ fetch: f }).tool('higgsfield_api_upload').execute({
      path: 'attachments/dog.png',
    });
    await expect(p).rejects.toThrow(/refused the upload request \(400\)/);
    await p.catch((e: Error) => {
      expect(e.message).not.toContain('sekret');
      expect(e.message).not.toContain('Signature=sig');
    });
  });

  it('a failed PUT reports the storage error code, never the signed URL', async () => {
    const { f } = fakeFetch((req) =>
      req.url.endsWith('/files/generate-upload-url')
        ? {
            status: 200,
            body: {
              upload_url: 'https://s3.test/put?X-Amz-Signature=sig',
              upload_headers: {},
              public_url: 'https://cdn.test/dog.png',
            },
          }
        : {
            status: 403,
            body: '<Error><Code>SignatureDoesNotMatch</Code><Message>at https://s3.test/put?X-Amz-Signature=sig</Message></Error>',
          },
    );
    const p = deps({ fetch: f }).tool('higgsfield_api_upload').execute({
      path: 'attachments/dog.png',
    });
    await expect(p).rejects.toThrow(/upload failed \(403\): SignatureDoesNotMatch/);
    await p.catch((e: Error) => expect(e.message).not.toContain('Signature=sig'));
  });

  it('refuses files outside attachments/ and outputs/, protected, too big, not media, outside the workspace', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'outputs', 'big.png'), Buffer.alloc(51 * 1024 * 1024));
    const { f, seen } = fakeFetch(() => ({ status: 200, body: {} }));
    const { tool } = deps({ fetch: f, workspace: ws });
    const up = (path: string) => tool('higgsfield_api_upload').execute({ path });
    await expect(up('src/a.png')).rejects.toThrow(/not under attachments\/ or outputs\//);
    await expect(up('.env')).rejects.toThrow(/protected/);
    await expect(up('attachments/secret.png')).rejects.toThrow(/protected/);
    await expect(up('outputs/big.png')).rejects.toThrow(/larger than/);
    await expect(up('attachments/notes.txt')).rejects.toThrow(/not an image, video or audio/);
    await expect(up('../outside.png')).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('scrub', () => {
  it('hides the key, its secret half and URLs with a query', () => {
    expect(scrub(`k=${KEY} s=sekret-abcdef u=https://s3/x?sig=1 v=https://cdn/a.png`, KEY)).toBe(
      'k=[redacted] s=[redacted] u=[redacted] v=https://cdn/a.png',
    );
    expect(scrub('nothing', undefined)).toBe('nothing');
  });
});

describe('defaultSleep', () => {
  it('removes its abort listener when the timer fires (no listeners pile up over polls)', async () => {
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => {
      added++;
      add(...a);
    }) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
      removed++;
      remove(...a);
    }) as typeof remove;
    for (let i = 0; i < 12; i++) await defaultSleep(1, ac.signal);
    expect(added).toBe(12);
    expect(removed).toBe(12);
  });

  it('resolves at once on abort', async () => {
    const ac = new AbortController();
    const p = defaultSleep(60_000, ac.signal);
    ac.abort();
    await p;
  });

  it('saveInto writes a media result over the 2 MB file-API cap into outputs/', async () => {
    const ws = workspace();
    const r = await saveInto(ws, [], 'hf-r-1-1.png', Buffer.alloc(3 * 1024 * 1024, 1));
    expect(r).toBe('outputs/hf-r-1-1.png');
    expect(statSync(join(ws, 'outputs', 'hf-r-1-1.png')).size).toBe(3 * 1024 * 1024);
  });
});
