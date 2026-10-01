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
const MIME: Record<string, string> = {
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

export interface HiggsfieldToolDeps {
  workspace: string;
  protectedGlobs: string[];
  /** A call on Higgsfield's MCP (the daemon's own connection, signed in through the CLI). */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** PUTs the bytes to a presigned URL; the HTTP status. */
  put(url: string, bytes: Buffer, contentType: string): Promise<number>;
}

/**
 * `higgsfield_upload(path)`: a workspace file (an attachment, an output) becomes a Higgsfield
 * media id the generation tools take as a reference. The daemon does the three steps the MCP
 * asks for (a presigned URL, the PUT, the confirmation), which the model cannot do itself.
 */
export function higgsfieldTools(d: HiggsfieldToolDeps): AgentTool[] {
  return [
    {
      name: 'higgsfield_upload',
      description:
        'Upload an image, video or audio file of the workspace (an attachment, an earlier output) to Higgsfield and get a media_id to pass as a reference in medias: [{ value: media_id, role }] of the generation tools.',
      input: z.object({ path: z.string().describe('The file, relative to the workspace') }),
      async execute(input) {
        const path = String(input.path ?? '');
        // the file first (inside the workspace, not protected, present), as raw bytes, then its kind
        const { file, rel } = confine(d.workspace, path);
        const globs = [...ALWAYS_PROTECTED, ...d.protectedGlobs];
        if (
          isProtected(rel, globs) ||
          isProtected(relative(realpathSync(d.workspace), file), globs)
        )
          throw new Error(`${rel} is protected: it is never sent anywhere`);
        const size = statSync(file).size;
        if (size > HIGGSFIELD_UPLOAD_LIMIT)
          throw new Error(`${rel} is larger than ${HIGGSFIELD_UPLOAD_LIMIT} bytes`);
        const ext = (rel.split('.').pop() ?? '').toLowerCase();
        const type = KIND[ext];
        if (!type)
          throw new Error(
            `${rel || '(empty)'} is not an image, video or audio file Higgsfield takes`,
          );
        const bytes = readFileSync(file);
        const filename = rel.split('/').pop() ?? rel;
        const contentType = MIME[ext] ?? `${type}/${ext}`;
        const answer = (await d.call('media_upload', {
          files: [{ filename, content_type: contentType }],
        })) as { structuredContent?: { uploads?: { media_id?: string; upload_url?: string }[] } };
        const upload = answer?.structuredContent?.uploads?.[0];
        if (!upload?.media_id || !upload.upload_url)
          throw new Error('Higgsfield gave no upload URL for the file');
        const status = await d.put(upload.upload_url, bytes, contentType);
        if (status < 200 || status >= 300) throw new Error(`upload failed (${status})`);
        await d.call('media_confirm', { type, media_id: upload.media_id });
        return { media_id: upload.media_id, type, path: rel, bytes: bytes.length };
      },
    },
  ];
}
