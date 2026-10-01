import type { RunFileContent } from './api/client.js';
import { blobToBase64 } from './desktop.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'heic']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
/** Thumbnails come from the bytes themselves: files past this are shown by their icon. */
const THUMB_LIMIT = 12 * 1024 * 1024;

export type ThumbKind = 'image' | 'video';

export function thumbKind(name: string, mime?: string): ThumbKind | undefined {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('video/')) return 'video';
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return undefined;
}

/** A URL a chip can show for a file the user picked (a data URL for images, an object URL for video). */
export async function thumbOfFile(file: File): Promise<string | undefined> {
  const kind = thumbKind(file.name, file.type);
  if (!kind || file.size > THUMB_LIMIT) return undefined;
  if (kind === 'image')
    return `data:${file.type || 'image/png'};base64,${await blobToBase64(file)}`;
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : undefined;
}

/**
 * A URL a chip can show for a file of a run: the preview content when it is a whole image,
 * else the whole download (an image past 2 MB, a video) as an object URL.
 */
export async function thumbOfRunFile(
  runId: string,
  path: string,
  mime: string | undefined,
  load: (runId: string, path: string) => Promise<RunFileContent>,
  loadWhole?: (runId: string, path: string) => Promise<Blob>,
): Promise<string | undefined> {
  const kind = thumbKind(path, mime);
  if (!kind) return undefined;
  if (kind === 'image') {
    const f = await load(runId, path);
    if (f.encoding === 'base64' && f.mime?.startsWith('image/') && !f.truncated)
      return `data:${f.mime};base64,${f.content}`;
    if (f.size > THUMB_LIMIT || !loadWhole) return undefined;
  }
  if (!loadWhole || typeof URL.createObjectURL !== 'function') return undefined;
  return URL.createObjectURL(await loadWhole(runId, path));
}
