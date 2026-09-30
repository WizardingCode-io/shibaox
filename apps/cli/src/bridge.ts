import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http';
import { serveAppFile } from '@wizardingcode/shibaox-daemon';

export interface BridgeOptions {
  /** The daemon's Unix socket. */
  socketPath: string;
  /** The built app (`dist/` of @wizardingcode/shibaox-app); undefined → /app says how to install it. */
  dist: string | undefined;
  /** The token the browser must send (random per session when omitted). */
  token?: string;
  host?: string;
  port?: number;
}

export interface Bridge {
  /** Where to open the browser: the app with its token in the fragment. */
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

const bearerOk = (header: string | undefined, token: string): boolean => {
  const given = header ? (header.match(/^bearer\s+(.*)$/i)?.[1] ?? '') : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

/**
 * A loopback HTTP server for the browser app when the daemon only has its Unix socket: it
 * serves the app under /app and forwards everything else to the socket, behind a token of
 * its own (the browser gets it once, in the URL fragment). Nothing off the loopback interface.
 */
export async function startBridge(o: BridgeOptions): Promise<Bridge> {
  const token = o.token ?? randomBytes(24).toString('hex');
  const host = o.host ?? '127.0.0.1';
  const forward = (req: IncomingMessage, res: ServerResponse) => {
    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.authorization;
    delete headers.host;
    const up = request(
      { socketPath: o.socketPath, path: req.url ?? '/', method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (!res.headersSent)
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          error: {
            code: 'daemon_unavailable',
            message: `no shibaox daemon at ${o.socketPath}: ${e.message}`,
          },
        }),
      );
    });
    req.pipe(up);
    res.on('close', () => up.destroy());
  };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (path === '/app' || path.startsWith('/app/'))
    )
      return serveAppFile(o.dist, path, res);
    if (req.method === 'GET' && path === '/') {
      res.writeHead(302, { location: '/app/' });
      return res.end();
    }
    if (!bearerOk(req.headers.authorization, token)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(
        JSON.stringify({
          error: {
            code: 'unauthorized',
            message: 'the app token is required (open the address shibaox app printed)',
          },
        }),
      );
    }
    forward(req, res);
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (o.port ?? 0);
  return {
    url: `http://${host}:${port}/app/#token=${token}`,
    token,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
