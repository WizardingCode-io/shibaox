import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { type AgentTool, isProtected } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import { ALWAYS_PROTECTED, confine } from './files.js';

const KIND: Record<string, 'image' | 'video' | 'audio'> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  heic: 'image',
  bmp: 'image',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  m4v: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  aac: 'audio',
  ogg: 'audio',
  flac: 'audio',
};
export const MEDIA_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
};
/** The largest file handed to Higgsfield (their URL import takes 50 MB). */
export const HIGGSFIELD_UPLOAD_LIMIT = 50 * 1024 * 1024;
/** How long a PUT may take: a minute plus a second per 100 KB (a slow uplink gets a video through), ten minutes at most, whole ms. */
export function uploadTimeoutMs(bytes: number): number {
  return Math.min(600_000, Math.ceil(60_000 + bytes / 100));
}
/** Only what the user sent or the run made leaves the machine: never the project's own media. */
const UPLOADABLE = /^(attachments|outputs)\//;

/** A workspace file that may be sent to Higgsfield, read whole. */
export interface UploadableFile {
  rel: string;
  bytes: Buffer;
  type: 'image' | 'video' | 'audio';
  contentType: string;
  filename: string;
}

/**
 * The checks every Higgsfield upload goes through: inside the workspace, not protected, under
 * attachments/ or outputs/, at most 50 MB, an image, video or audio file. Throws with the reason.
 */
export function uploadableFile(
  workspace: string,
  path: string,
  protectedGlobs: string[],
): UploadableFile {
  // the file first (inside the workspace, not protected, present), as raw bytes, then its kind
  const { file, rel } = confine(workspace, path);
  const globs = [...ALWAYS_PROTECTED, ...protectedGlobs];
  if (isProtected(rel, globs) || isProtected(relative(realpathSync(workspace), file), globs))
    throw new Error(`${rel} is protected: it is never sent anywhere`);
  if (!UPLOADABLE.test(rel))
    throw new Error(
      `${rel} is not under attachments/ or outputs/: only what the user sent or you made goes to Higgsfield`,
    );
  const size = statSync(file).size;
  if (size > HIGGSFIELD_UPLOAD_LIMIT)
    throw new Error(`${rel} is larger than ${HIGGSFIELD_UPLOAD_LIMIT} bytes`);
  const ext = (rel.split('.').pop() ?? '').toLowerCase();
  const type = KIND[ext];
  if (!type)
    throw new Error(`${rel || '(empty)'} is not an image, video or audio file Higgsfield takes`);
  return {
    rel,
    bytes: readFileSync(file),
    type,
    contentType: MEDIA_MIME[ext] ?? `${type}/${ext}`,
    filename: rel.split('/').pop() ?? rel,
  };
}

export interface Upload {
  media_id: string;
  upload_url: string;
}
export interface HiggsfieldToolDeps {
  workspace: string;
  protectedGlobs: string[];
  /** The three steps on one Higgsfield MCP connection (the daemon's own, signed in through the CLI). */
  withMcp<T>(
    f: (call: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<T>,
  ): Promise<T>;
  /** PUTs the bytes to a presigned URL; the HTTP status and the start of the body. */
  put(url: string, bytes: Buffer, contentType: string): Promise<{ status: number; body: string }>;
}

/** The upload the MCP answered with: `connectMcp.call` hands over structuredContent itself, or text. */
export function parseUpload(answer: unknown): Upload | undefined {
  const fromList = (u: unknown): Upload | undefined => {
    const first = Array.isArray(u)
      ? (u[0] as { media_id?: unknown; upload_url?: unknown })
      : undefined;
    return first && typeof first.media_id === 'string' && typeof first.upload_url === 'string'
      ? { media_id: first.media_id, upload_url: first.upload_url }
      : undefined;
  };
  if (answer && typeof answer === 'object') {
    const o = answer as { uploads?: unknown; structuredContent?: { uploads?: unknown } };
    return fromList(o.uploads) ?? fromList(o.structuredContent?.uploads);
  }
  if (typeof answer === 'string') {
    try {
      const parsed = JSON.parse(answer) as { uploads?: unknown };
      const u = fromList(parsed.uploads);
      if (u) return u;
    } catch {
      // the prose answer: the id and the URL are in it
    }
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(answer)?.[1];
    const url = /'(https:\/\/[^']+)'|(https:\/\/\S+)/.exec(answer);
    const upload_url = url?.[1] ?? url?.[2];
    if (id && upload_url) return { media_id: id, upload_url };
  }
  return undefined;
}

/**
 * `higgsfield_upload(path)`: an attachment the user sent or an output of a run becomes a
 * Higgsfield media id the generation tools take as a reference. The daemon does the three
 * steps the MCP asks for (a presigned URL, the PUT, the confirmation), which the model cannot.
 */
export function higgsfieldTools(d: HiggsfieldToolDeps): AgentTool[] {
  return [
    {
      name: 'higgsfield_upload',
      description:
        'Upload an image, video or audio file from attachments/ (what the user sent) or outputs/ (what you made) to Higgsfield and get a media_id to pass as a reference in medias: [{ value: media_id, role }] of the generation tools.',
      input: z.object({ path: z.string().describe('The file, relative to the workspace') }),
      async execute(input) {
        const { rel, bytes, type, contentType, filename } = uploadableFile(
          d.workspace,
          String(input.path ?? ''),
          d.protectedGlobs,
        );
        return d.withMcp(async (call) => {
          const upload = parseUpload(
            await call('media_upload', { files: [{ filename, content_type: contentType }] }),
          );
          if (!upload) throw new Error('Higgsfield gave no upload URL for the file');
          const r = await d.put(upload.upload_url, bytes, contentType);
          if (r.status < 200 || r.status >= 300)
            throw new Error(`upload failed (${r.status}): ${r.body.slice(0, 300)}`);
          try {
            await call('media_confirm', { type, media_id: upload.media_id });
          } catch (e) {
            // the bytes are there: the id is usable, the confirmation can be repeated without a new upload
            return {
              media_id: upload.media_id,
              type,
              path: rel,
              bytes: bytes.length,
              confirmed: false,
              note: `media_confirm failed (${e instanceof Error ? e.message : String(e)}): call it again with this media_id`,
            };
          }
          return {
            media_id: upload.media_id,
            type,
            path: rel,
            bytes: bytes.length,
            confirmed: true,
          };
        });
      },
    },
  ];
}
