import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { type AgentTool, isProtected } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import { ALWAYS_PROTECTED, confine } from './files.js';
import { MEDIA_MIME } from './higgsfield-tools.js';

/** What the daemon's Telegram send answers. */
export type TelegramSendResult = { sent: true; chatId: number } | { sent: false; reason: string };

export interface TelegramToolDeps {
  /** The daemon's `telegramSend`: the bot token never reaches the model. */
  send(text: string): Promise<TelegramSendResult>;
  /** The daemon's `telegramSendFile` (photo, video, audio or document by type). */
  sendFile(
    file: { bytes: Buffer; filename: string; mime: string },
    caption?: string,
  ): Promise<TelegramSendResult>;
  /** The run's workspace: only its files (never protected ones) can be sent. */
  workspace: string;
  protectedGlobs: string[];
}

/** Telegram takes 50 MB per upload from a bot. */
export const TELEGRAM_SEND_LIMIT = 50 * 1024 * 1024;

const DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  glb: 'model/gltf-binary',
  svg: 'image/svg+xml',
};

/** A workspace file as Telegram will get it: confined, never protected, under the limit. */
export function fileToSend(
  workspace: string,
  path: string,
  protectedGlobs: string[],
): { bytes: Buffer; filename: string; mime: string; rel: string } {
  const { file, rel } = confine(workspace, path);
  if (isProtected(rel, [...ALWAYS_PROTECTED, ...protectedGlobs]))
    throw new Error(`${rel} is protected: it is never sent`);
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error(`${rel} is not a file`);
    size = st.size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`${rel} not found in the workspace`);
    throw e;
  }
  if (size > TELEGRAM_SEND_LIMIT)
    throw new Error(`${rel} is ${size} bytes; Telegram takes 50 MB at most`);
  const ext = extname(rel).slice(1).toLowerCase();
  const mime = MEDIA_MIME[ext] ?? DOC_MIME[ext] ?? 'application/octet-stream';
  const filename = rel.split('/').pop() ?? rel;
  return { bytes: readFileSync(file), filename, mime, rel };
}

/** Why a send failed, in words the model can repeat to the user. */
function failure(reason: string): string {
  if (reason === 'not paired')
    return 'Telegram is not paired: Customize → Plugins → Telegram → Pair';
  if (reason === 'no token')
    return 'Telegram has no bot token: Customize → Plugins → Telegram (SHIBAOX_TELEGRAM_TOKEN)';
  return `Telegram could not send: ${reason}`;
}

/** `telegram_send(text)`: a message to the chat paired with the bot (Plugins → Telegram). */
export function telegramTools(d: TelegramToolDeps): AgentTool[] {
  return [
    {
      name: 'telegram_send',
      description:
        "Send a message and/or a file of the workspace to the user's Telegram chat (the one paired in Plugins → Telegram): images go as photos, videos as videos, audio as audio, anything else as a document (50 MB at most); the text becomes the caption. Plain text; long text is split.",
      input: z
        .object({
          text: z
            .string()
            .optional()
            .describe('The message, plain text (the caption when a file is sent)'),
          path: z
            .string()
            .optional()
            .describe(
              'A file of the workspace to send (outputs/…, attachments/…); never a protected file',
            ),
        })
        .refine((v) => (v.text?.trim() ?? '') !== '' || (v.path?.trim() ?? '') !== '', {
          message: 'give text, a path, or both',
        }),
      async execute(input) {
        const text = String(input.text ?? '').trim();
        const path = String(input.path ?? '').trim();
        if (path) {
          const f = fileToSend(d.workspace, path, d.protectedGlobs);
          const r = await d.sendFile(
            { bytes: f.bytes, filename: f.filename, mime: f.mime },
            text || undefined,
          );
          if (!r.sent) throw new Error(failure(r.reason));
          return { sent: true, chatId: r.chatId, file: f.rel };
        }
        const r = await d.send(text);
        if (!r.sent) throw new Error(failure(r.reason));
        return { sent: true, chatId: r.chatId };
      },
    },
  ];
}
