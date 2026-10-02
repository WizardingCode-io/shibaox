import type { AgentTool } from '@wizardingcode/shibaox-core';
import { z } from 'zod';

/** What the daemon's Telegram send answers. */
export type TelegramSendResult = { sent: true; chatId: number } | { sent: false; reason: string };

export interface TelegramToolDeps {
  /** The daemon's `telegramSend`: the bot token never reaches the model. */
  send(text: string): Promise<TelegramSendResult>;
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
        "Send a text message to the user's Telegram chat (the one paired in Plugins → Telegram). Plain text; long text is split.",
      input: z.object({ text: z.string().min(1).describe('The message, plain text') }),
      async execute(input) {
        const r = await d.send(String(input.text ?? ''));
        if (!r.sent) throw new Error(failure(r.reason));
        return { sent: true, chatId: r.chatId };
      },
    },
  ];
}
