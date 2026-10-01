import type { Attachment } from '@wizardingcode/shibaox-daemon';
import { blobToBase64 } from './desktop.js';

export const ATTACH_MAX_FILES = 20;
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** The files after adding `picked`, or the reason none were taken (checked on size, not after encoding). */
export function addFiles(
  current: readonly File[],
  picked: readonly File[],
): { files: File[]; notice?: string } {
  if (picked.length === 0) return { files: [...current] };
  const files = [...current, ...picked];
  if (files.length > ATTACH_MAX_FILES)
    return { files: [...current], notice: `At most ${ATTACH_MAX_FILES} files go with a message.` };
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > ATTACH_MAX_BYTES)
    return {
      files: [...current],
      notice: `Attachments add up to more than ${Math.round(ATTACH_MAX_BYTES / 1024 / 1024)} MB: leave some out.`,
    };
  return { files };
}

/** The files as the daemon takes them (base64). */
export async function encodeFiles(files: readonly File[]): Promise<Attachment[]> {
  return Promise.all(
    files.map(async (f) => ({
      name: f.name,
      content: await blobToBase64(f),
      ...(f.type ? { mime: f.type } : {}),
    })),
  );
}

/** Whether a drag carries files (never text or links). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  return Array.from(dt.types ?? []).includes('Files');
}
