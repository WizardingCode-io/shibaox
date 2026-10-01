// The main process bundled to one file (only `electron` stays external; the CommonJS updater
// gets a `require` of its own), the built browser app copied next to it, the offline page too:
// the packaged app ships dist/ and nothing else.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: [join(here, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['electron'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  outfile: join(dist, 'main.mjs'),
  sourcemap: true,
  logLevel: 'warning',
});
const appDist = join(dirname(require.resolve('@wizardingcode/shibaox-app/package.json')), 'dist');
if (!existsSync(join(appDist, 'index.html')))
  throw new Error(`the browser app is not built: ${appDist}`);
cpSync(appDist, join(dist, 'app'), { recursive: true });
cpSync(join(here, 'static'), dist, { recursive: true });
console.log('desktop: dist/main.mjs + dist/app + dist/offline.html');
