import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { telegramTools } from '../src/runs/telegram-tools.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tool = (
  send: (text: string) => Promise<unknown>,
  o: { workspace?: string; sendFile?: (f: unknown, caption?: string) => Promise<unknown> } = {},
) => {
  const [t] = telegramTools({
    send: send as Parameters<typeof telegramTools>[0]['send'],
    sendFile: (o.sendFile ?? (async () => ({ sent: true, chatId: 42 }))) as never,
    workspace: o.workspace ?? mkdtempSync(join(tmpdir(), 'tgw-')),
    protectedGlobs: ['secret/**'],
  });
  if (!t) throw new Error('no tool');
  return t;
};

describe('telegram_send', () => {
  it('sends the text through the daemon and returns where it went', async () => {
    const sent: string[] = [];
    const t = tool(async (text) => {
      sent.push(text);
      return { sent: true, chatId: 42 };
    });
    expect(t.name).toBe('telegram_send');
    expect(t.input.safeParse({ text: '' }).success).toBe(false);
    expect(await t.execute({ text: 'olá' })).toEqual({ sent: true, chatId: 42 });
    expect(sent).toEqual(['olá']);
  });

  it('not paired, or no token: a clear error the model can say', async () => {
    await expect(
      tool(async () => ({ sent: false, reason: 'not paired' })).execute({ text: 'x' }),
    ).rejects.toThrow('Telegram is not paired: Customize → Plugins → Telegram → Pair');
    await expect(
      tool(async () => ({ sent: false, reason: 'no token' })).execute({ text: 'x' }),
    ).rejects.toThrow(/no bot token/);
    await expect(
      tool(async () => ({ sent: false, reason: 'channel not running' })).execute({ text: 'x' }),
    ).rejects.toThrow(/channel not running/);
  });

  it('the assistant role of the template has the telegram tool and the prompt names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgtools-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    expect(readFileSync(join(dir, 'org/roles/assistant.yaml'), 'utf8')).toMatch(
      /tools: \[[^\]]*\btelegram\b/,
    );
    expect(readFileSync(join(dir, 'org/prompts/assistant.md'), 'utf8')).toContain(
      '`telegram_send(text, path?)` sends a message, or a file of the workspace',
    );
  });

  it('a workspace file goes out as a photo, video or document, the text as its caption', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tgw-'));
    tmp.push(ws);
    mkdirSync(join(ws, 'outputs'), { recursive: true });
    writeFileSync(join(ws, 'outputs', 'shiba.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    const files: { filename: string; mime: string; bytes: number; caption?: string }[] = [];
    const t = tool(async () => ({ sent: true, chatId: 42 }), {
      workspace: ws,
      sendFile: async (f, caption) => {
        const x = f as { filename: string; mime: string; bytes: Buffer };
        files.push({ filename: x.filename, mime: x.mime, bytes: x.bytes.length, caption });
        return { sent: true, chatId: 42 };
      },
    });
    expect(await t.execute({ path: 'outputs/shiba.png', text: 'um shiba' })).toEqual({
      sent: true,
      chatId: 42,
      file: 'outputs/shiba.png',
    });
    expect(files).toEqual([
      { filename: 'shiba.png', mime: 'image/png', bytes: 5, caption: 'um shiba' },
    ]);
  });
  it('refuses a file outside the workspace, a protected one, a missing one, or one over 50 MB', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'tgw-'));
    tmp.push(ws);
    mkdirSync(join(ws, 'secret'), { recursive: true });
    writeFileSync(join(ws, 'secret', 'k.txt'), 'x');
    writeFileSync(join(ws, '.env'), 'x');
    const t = tool(async () => ({ sent: true, chatId: 42 }), { workspace: ws });
    await expect(t.execute({ path: '../etc/passwd' })).rejects.toThrow(/outside|workspace/);
    await expect(t.execute({ path: 'secret/k.txt' })).rejects.toThrow(/protected/);
    await expect(t.execute({ path: '.env' })).rejects.toThrow(/protected/);
    await expect(t.execute({ path: 'outputs/nope.png' })).rejects.toThrow(
      /not found|no such|in the workspace/i,
    );
    expect(t.input.safeParse({}).success).toBe(false);
  });
});
