import { createServer } from 'node:http';

export interface FakeTurn {
  content?: string;
  toolCalls?: { name: string; args: unknown }[];
  /** Overrides the OpenAI `finish_reason` (default: `tool_calls` with tool calls, else `stop`). */
  finishReason?: string;
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
        let parsed: { messages: unknown[]; tools?: unknown[]; stream?: boolean };
        try {
          parsed = JSON.parse(body) as { messages: unknown[]; tools?: unknown[]; stream?: boolean };
        } catch {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'invalid json' } }));
          return;
        }
        requests.push(parsed);
        try {
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
          const finishReason = t.finishReason ?? (t.toolCalls ? 'tool_calls' : 'stop');
          if (parsed.stream) {
            // server-sent events, the way OpenAI-compatible servers stream: text in pieces,
            // tool calls as one delta, then the finish reason and the usage
            res.setHeader('content-type', 'text/event-stream');
            const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
              res.write(
                `data: ${JSON.stringify({
                  id: `chatcmpl-${turn}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: 'm',
                  choices: [{ index: 0, delta, finish_reason: finish }],
                })}\n\n`,
              );
            chunk({ role: 'assistant' });
            if (t.toolCalls)
              chunk({
                tool_calls: t.toolCalls.map((c, i) => ({
                  index: i,
                  id: `call_${turn}_${i}`,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                })),
              });
            else {
              const text = t.content ?? '';
              const pieces = [...text].reduce<string[]>((acc, ch, i) => {
                if (i % 7 === 0) acc.push('');
                acc[acc.length - 1] += ch;
                return acc;
              }, []);
              for (const piece of pieces) chunk({ content: piece });
            }
            chunk({}, finishReason);
            res.write(
              `data: ${JSON.stringify({
                id: `chatcmpl-${turn}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: 'm',
                choices: [],
                usage: {
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                  total_tokens: promptTokens + completionTokens,
                },
              })}\n\n`,
            );
            res.end('data: [DONE]\n\n');
            return;
          }
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              id: `chatcmpl-${turn}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: 'm',
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: finishReason,
                },
              ],
              usage: {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
              },
            }),
          );
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              error: { message: err instanceof Error ? err.message : String(err) },
            }),
          );
        }
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
