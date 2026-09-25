import { createServer } from 'node:http';

export async function startFakeJev(
  script: (req: {
    state: unknown;
    questions: Record<string, { type: string }>;
  }) => Record<string, unknown>,
) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (!req.url?.includes('/systemone')) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const parsed = JSON.parse(body) as {
        state: unknown;
        questions: Record<string, { type: string }>;
      };
      requests.push(parsed);
      const answers = script(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers,
          usage: { input_tokens: Math.max(1, Math.ceil(body.length / 4)), output_tokens: 0 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
