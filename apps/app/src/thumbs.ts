import type { RunFileContent } from './api/client.js';
import { blobToBase64 } from './desktop.js';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v']);
/** Thumbnails come from the bytes themselves: files past this are shown by their icon. */
export const THUMB_LIMIT = 12 * 1024 * 1024;
/** What the daemon's preview carries at most (RUN_FILE_LIMIT): past it the whole download is needed. */
const PREVIEW_LIMIT = 2_000_000;

export type ThumbKind = 'image' | 'video';

export function thumbKind(name: string, mime?: string): ThumbKind | undefined {
  if (mime?.startsWith('image/')) return mime === 'image/heic' ? undefined : 'image';
  if (mime?.startsWith('video/')) return 'video';
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return undefined;
}

const objectUrl = (b: Blob): string | undefined =>
  typeof URL.createObjectURL === 'function' ? URL.createObjectURL(b) : undefined;

/** A URL a chip can show for a file the user picked: an object URL (a data URL where there are none). */
export async function thumbOfFile(file: File): Promise<string | undefined> {
  const kind = thumbKind(file.name, file.type);
  if (!kind || file.size > THUMB_LIMIT) return undefined;
  const url = objectUrl(file);
  if (url) return url;
  if (kind === 'image')
    return `data:${file.type || 'image/png'};base64,${await blobToBase64(file)}`;
  return undefined;
}

/**
 * A URL a chip can show for a file of a run. A known size decides without a request: past the
 * thumbnail cap nothing is fetched; past the preview cap the whole download is fetched once.
 */
export async function thumbOfRunFile(
  runId: string,
  path: string,
  o: { mime?: string; size?: number },
  load: (runId: string, path: string) => Promise<RunFileContent>,
  loadWhole?: (runId: string, path: string) => Promise<Blob>,
): Promise<string | undefined> {
  const kind = thumbKind(path, o.mime);
  if (!kind) return undefined;
  if (o.size !== undefined && o.size > THUMB_LIMIT) return undefined;
  const whole = async () => (loadWhole ? objectUrl(await loadWhole(runId, path)) : undefined);
  if (kind === 'video') {
    if (o.size === undefined) {
      // the size is not known: the preview says it
      const f = await load(runId, path);
      if (f.size > THUMB_LIMIT) return undefined;
    }
    return whole();
  }
  if (o.size !== undefined && o.size > PREVIEW_LIMIT) return whole();
  const f = await load(runId, path);
  if (f.encoding === 'base64' && f.mime?.startsWith('image/') && !f.truncated)
    return `data:${f.mime};base64,${f.content}`;
  if (f.size > THUMB_LIMIT) return undefined;
  return whole();
}

/** Lets go of an object URL (a data URL needs nothing). */
export function dropThumb(url: string | undefined): void {
  if (url?.startsWith('blob:')) URL.revokeObjectURL(url);
}
