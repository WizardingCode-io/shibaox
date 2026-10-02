import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { telegramTools } from '../src/runs/telegram-tools.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tool = (send: (text: string) => Promise<unknown>) => {
  const [t] = telegramTools({
    send: send as Parameters<typeof telegramTools>[0]['send'],
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
      '`telegram_send(text)` sends a message to the paired chat',
    );
  });
});
