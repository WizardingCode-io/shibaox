import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HIGGSFIELD_UPLOAD_LIMIT,
  higgsfieldTools,
  parseUpload,
  uploadTimeoutMs,
} from '../src/runs/higgsfield-tools.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'hfup-'));
  tmp.push(ws);
  mkdirSync(join(ws, 'attachments'));
  mkdirSync(join(ws, 'docs'));
  writeFileSync(join(ws, 'attachments', 'dog.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  writeFileSync(join(ws, 'docs', 'admin.png'), Buffer.from([1, 2, 3]));
  writeFileSync(join(ws, '.env'), 'S=1');
  return ws;
}
type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const withMcp =
  (call: Call) =>
  <T>(f: (c: Call) => Promise<T>) =>
    f(call);

describe('higgsfield_upload', () => {
  it('reads a workspace file, asks for an upload URL, PUTs the bytes and confirms, on one connection', async () => {
    const ws = workspace();
    const calls: { tool: string; args: unknown }[] = [];
    const puts: { url: string; bytes: number; type: string }[] = [];
    let connections = 0;
    const [tool] = higgsfieldTools({
      workspace: ws,
      protectedGlobs: [],
      withMcp: async (f) => {
        connections++;
        return f(async (name, args) => {
          calls.push({ tool: name, args });
          // what connectMcp.call hands over: structuredContent itself
          if (name === 'media_upload')
            return {
              uploads: [{ media_id: 'm-1', upload_url: 'https://upload.example/m-1.png?sig=x' }],
            };
          if (name === 'media_confirm')
            return { results: [{ media_id: 'm-1', status: 'uploaded' }] };
          throw new Error(`unexpected ${name}`);
        });
      },
      put: async (url, bytes, type) => {
        puts.push({ url, bytes: bytes.length, type });
        return { status: 200, body: '' };
      },
    });
    expect(tool?.name).toBe('higgsfield_upload');
    const r = await tool?.execute({ path: 'attachments/dog.png' });
    expect(r).toEqual({
      media_id: 'm-1',
      type: 'image',
      path: 'attachments/dog.png',
      bytes: 6,
      confirmed: true,
    });
    expect(connections).toBe(1);
    expect(calls.map((c) => c.tool)).toEqual(['media_upload', 'media_confirm']);
    expect(calls[0]?.args).toEqual({ files: [{ filename: 'dog.png', content_type: 'image/png' }] });
    expect(calls[1]?.args).toEqual({ type: 'image', media_id: 'm-1' });
    expect(puts).toEqual([
      { url: 'https://upload.example/m-1.png?sig=x', bytes: 6, type: 'image/png' },
    ]);
  });
  it('refuses project media, non-media, protected, missing and outside files, and shows the PUT error body', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'attachments', 'notes.md'), '# x');
    const [tool] = higgsfieldTools({
      workspace: ws,
      protectedGlobs: [],
      withMcp: withMcp(async () => ({ uploads: [{ media_id: 'm', upload_url: 'https://u' }] })),
      put: async () => ({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' }),
    });
    await expect(tool?.execute({ path: 'docs/admin.png' })).rejects.toThrow(
      /attachments\/ or outputs\//,
    );
    await expect(tool?.execute({ path: 'attachments/notes.md' })).rejects.toThrow(
      /image, video or audio/,
    );
    await expect(tool?.execute({ path: '.env' })).rejects.toThrow(/protected/);
    await expect(tool?.execute({ path: 'attachments/nope.png' })).rejects.toThrow(
      /no attachments\/nope\.png/,
    );
    await expect(tool?.execute({ path: '../outside.png' })).rejects.toThrow(/workspace/);
    await expect(tool?.execute({ path: 'attachments/dog.png' })).rejects.toThrow(
      /upload failed \(403\): <Error><Code>SignatureDoesNotMatch/,
    );
  });
  it('a failed confirmation keeps the id (the bytes are there) instead of failing', async () => {
    const ws = workspace();
    const [tool] = higgsfieldTools({
      workspace: ws,
      protectedGlobs: [],
      withMcp: withMcp(async (name) => {
        if (name === 'media_upload')
          return { uploads: [{ media_id: 'm-2', upload_url: 'https://u' }] };
        throw new Error('timeout');
      }),
      put: async () => ({ status: 200, body: '' }),
    });
    await expect(tool?.execute({ path: 'attachments/dog.png' })).resolves.toMatchObject({
      media_id: 'm-2',
      confirmed: false,
    });
  });
  it('parseUpload takes the structured list, a JSON string, or the prose answer', () => {
    expect(parseUpload({ uploads: [{ media_id: 'a', upload_url: 'https://x' }] })).toEqual({
      media_id: 'a',
      upload_url: 'https://x',
    });
    expect(
      parseUpload({ structuredContent: { uploads: [{ media_id: 'b', upload_url: 'https://y' }] } }),
    ).toEqual({ media_id: 'b', upload_url: 'https://y' });
    expect(
      parseUpload(JSON.stringify({ uploads: [{ media_id: 'c', upload_url: 'https://z' }] })),
    ).toEqual({ media_id: 'c', upload_url: 'https://z' });
    expect(
      parseUpload(
        'Generated 1 upload URL.\n- 55fe50a9-0280-449c-b1e4-b7e7ec052b01: Upload the file using: curl -X PUT -H "Content-Type: image/png" --data-binary @tiny.png \'https://upload.higgsfield.ai/u/55fe.png?X-Amz-Signature=abc\'',
      ),
    ).toEqual({
      media_id: '55fe50a9-0280-449c-b1e4-b7e7ec052b01',
      upload_url: 'https://upload.higgsfield.ai/u/55fe.png?X-Amz-Signature=abc',
    });
    expect(parseUpload('nothing here')).toBeUndefined();
  });
});

describe('uploadTimeoutMs', () => {
  it('gives a whole number of milliseconds (a fractional delay makes AbortSignal.timeout throw)', () => {
    // a 1.9 MB screenshot: 60 s plus a second per 100 KB, rounded up
    expect(uploadTimeoutMs(1_919_128)).toBe(79_192);
    expect(Number.isInteger(uploadTimeoutMs(123_456_789))).toBe(true);
  });
  it('never waits more than ten minutes', () => {
    expect(uploadTimeoutMs(HIGGSFIELD_UPLOAD_LIMIT)).toBe(584_288);
    expect(uploadTimeoutMs(100 * 1024 * 1024)).toBe(600_000);
  });
});
