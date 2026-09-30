import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';

/** Where the built browser app lives: the `dist/` of `@wizardingcode/shibaox-app`, when installed. */
export function resolveAppDist(fromUrl: string = import.meta.url): string | undefined {
  const require = createRequire(fromUrl);
  try {
    const dist = join(dirname(require.resolve('@wizardingcode/shibaox-app/package.json')), 'dist');
    return existsSync(join(dist, 'index.html')) ? dist : undefined;
  } catch {
    return undefined;
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export const APP_MISSING =
  'the browser app is not installed next to this daemon: npm i -g shibaox@latest (it ships with shibaox 0.2.1+), then shibaox daemon stop so the daemon restarts on it';

/**
 * Serves one request under `/app`: a file of the dist by its path (hashed assets cached for a
 * year), `index.html` for `/app`, `/app/` and any path without an extension (the app's own
 * routes), 404 for anything else. Paths never leave the dist.
 */
export function serveAppFile(dist: string | undefined, urlPath: string, res: ServerResponse): void {
  if (!dist) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: APP_MISSING } }));
    return;
  }
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath.replace(/^\/app\/?/, ''));
  } catch {
    rel = '';
  }
  const root = resolve(dist);
  const target = normalize(join(root, rel));
  const inside = target === root || target.startsWith(root + sep);
  const isFile = inside && existsSync(target) && statSync(target).isFile();
  const wantsIndex = rel === '' || (!isFile && extname(rel) === '');
  const file = wantsIndex ? join(root, 'index.html') : isFile ? target : undefined;
  if (!file || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: `no ${urlPath} in the app` } }));
    return;
  }
  const hashed = /^assets\//.test(rel) && !wantsIndex;
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}
