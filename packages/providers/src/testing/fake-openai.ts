import { createServer } from 'node:http';

export interface FakeTurn {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
}
export type FakeScript = (
  req: { messages: unknown[]; tools?: unknown[] },
  turn: number,
) => FakeTurn | Promise<FakeTurn>;

export async function startFakeOpenAI(script: FakeScript) {
  const requests: unknown[] = [];
  let turn = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      void (async () => {
        if (!req.url?.endsWith('/chat/completions')) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        const parsed = JSON.parse(body) as { messages: unknown[]; tools?: unknown[] };
        requests.push(parsed);
        const t = await script(parsed, turn++);
        const message = t.toolCalls
          ? {
              role: 'assistant',
              content: null,
              tool_calls: t.toolCalls.map((c, i) => ({
                id: `call_${turn}_${i}`,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : { role: 'assistant', content: t.content ?? '' };
        const promptTokens = Math.max(1, Math.ceil(body.length / 4));
        const completionTokens = Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: `chatcmpl-${turn}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'm',
            choices: [{ index: 0, message, finish_reason: t.toolCalls ? 'tool_calls' : 'stop' }],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          }),
        );
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
