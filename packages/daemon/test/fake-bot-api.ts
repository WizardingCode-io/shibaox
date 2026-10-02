import { createServer, type Server } from 'node:http';

export interface Call {
  method: string;
  token: string;
  body: Record<string, unknown>;
}

/** A Bot API fake: `getUpdates` answers from `updates` (by offset) once `emptyPolls` ran out. */
export async function fakeBotApi(o: { emptyPolls?: number; conflicts?: number } = {}) {
  const calls: Call[] = [];
  const updates: { update_id: number; [k: string]: unknown }[] = [];
  let empty = o.emptyPolls ?? 0;
  // another program long-polling the same bot: Telegram answers 409 Conflict for a while
  let conflicts = o.conflicts ?? 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parts = (req.url ?? '').split('/');
      const method = parts.pop() ?? '';
      const token = (parts.pop() ?? '').replace(/^bot/, '');
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      calls.push({ method, token, body });
      if (method === 'getUpdates' && conflicts > 0) {
        conflicts--;
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            ok: false,
            error_code: 409,
            description:
              'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
          }),
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (method === 'getUpdates') {
        if (empty > 0) {
          empty--;
          return res.end(JSON.stringify({ ok: true, result: [] }));
        }
        const offset = Number(body.offset ?? 0);
        return res.end(
          JSON.stringify({ ok: true, result: updates.filter((u) => u.update_id >= offset) }),
        );
      }
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    apiBase: `http://127.0.0.1:${port}/bot`,
    calls,
    push: (u: { update_id: number; [k: string]: unknown }) => updates.push(u),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const start = (id: number, chatId: number, text = '/start') => ({
  update_id: id,
  message: {
    message_id: 100 + id,
    text,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, username: 'andre' },
  },
});
