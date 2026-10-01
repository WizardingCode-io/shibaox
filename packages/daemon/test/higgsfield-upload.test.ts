import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { higgsfieldTools } from '../src/runs/higgsfield-tools.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), 'hfup-'));
  tmp.push(ws);
  mkdirSync(join(ws, 'attachments'));
  writeFileSync(join(ws, 'attachments', 'dog.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
  writeFileSync(join(ws, '.env'), 'S=1');
  return ws;
}

describe('higgsfield_upload', () => {
  it('reads a workspace file, asks for an upload URL, PUTs the bytes and confirms: the media id comes back', async () => {
    const ws = workspace();
    const calls: { tool: string; args: unknown }[] = [];
    const puts: { url: string; bytes: number; type: string }[] = [];
    const [tool] = higgsfieldTools({
      workspace: ws,
      protectedGlobs: [],
      call: async (name, args) => {
        calls.push({ tool: name, args });
        if (name === 'media_upload')
          return {
            structuredContent: {
              uploads: [
                {
                  media_id: 'm-1',
                  upload_url: 'https://upload.example/m-1.png?sig=x',
                  content_type: 'image/png',
                },
              ],
            },
          };
        if (name === 'media_confirm')
          return { structuredContent: { results: [{ media_id: 'm-1', status: 'uploaded' }] } };
        throw new Error(`unexpected ${name}`);
      },
      put: async (url, bytes, type) => {
        puts.push({ url, bytes: bytes.length, type });
        return 200;
      },
    });
    expect(tool?.name).toBe('higgsfield_upload');
    const r = await tool?.execute({ path: 'attachments/dog.png' });
    expect(r).toEqual({ media_id: 'm-1', type: 'image', path: 'attachments/dog.png', bytes: 6 });
    expect(calls.map((c) => c.tool)).toEqual(['media_upload', 'media_confirm']);
    expect(calls[0]?.args).toEqual({ files: [{ filename: 'dog.png', content_type: 'image/png' }] });
    expect(calls[1]?.args).toEqual({ type: 'image', media_id: 'm-1' });
    expect(puts).toEqual([
      { url: 'https://upload.example/m-1.png?sig=x', bytes: 6, type: 'image/png' },
    ]);
  });
  it('refuses what is not an image, video or audio, a protected or missing file, and a failed PUT', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'notes.md'), '# x');
    const [tool] = higgsfieldTools({
      workspace: ws,
      protectedGlobs: [],
      call: async () => ({
        structuredContent: {
          uploads: [{ media_id: 'm', upload_url: 'https://u', content_type: 'image/png' }],
        },
      }),
      put: async () => 403,
    });
    await expect(tool?.execute({ path: 'notes.md' })).rejects.toThrow(/image, video or audio/);
    await expect(tool?.execute({ path: '.env' })).rejects.toThrow(/protected/);
    await expect(tool?.execute({ path: 'attachments/nope.png' })).rejects.toThrow(
      /no attachments\/nope\.png/,
    );
    await expect(tool?.execute({ path: '../outside.png' })).rejects.toThrow(/workspace/);
    await expect(tool?.execute({ path: 'attachments/dog.png' })).rejects.toThrow(
      /upload failed \(403\)/,
    );
  });
});
