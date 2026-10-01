// Fidelity pass: renders the design system's ChatScreen mockup and the app side by side in a
// headless browser (Playwright MCP) and prints the measures that must match (sidebar, top bar,
// thread, composer, type). Usage: node scripts/fidelity.mjs <app url with #token> [out dir]
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// the dev checkout's build of the direct adapter (the MCP client); not an app dependency
import { connectMcp } from '../../../packages/adapter-direct/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const appUrl = process.argv[2];
const out = resolve(process.argv[3] ?? join(here, '..', 'fidelity-out'));
if (!appUrl) {
  console.error('usage: node scripts/fidelity.mjs <app url> [out dir]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const vendor = resolve(here, '..', 'vendor', 'design-system');
const dsHome =
  process.env.SHIBAOX_DESIGN_SYSTEM ??
  join(process.env.HOME ?? '', 'Projects/shibaox/design-system');
const preview = readFileSync(join(dsHome, 'components/ChatScreen/preview.html'), 'utf8');
const style = /<style>([\s\S]*?)<\/style>/.exec(preview)?.[1] ?? '';
const script = /<script>([\s\S]*?)<\/script>/.exec(preview)?.[1] ?? '';
// the browser (Playwright MCP) refuses file: URLs: a throwaway server hands out the mockup and the design system
const roots = { '/out/': out, '/vendor/': vendor, '/ds/': dsHome };
const TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer((req, res) => {
  let path = '/';
  try {
    path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  const prefix = Object.keys(roots).find((k) => path.startsWith(k));
  const file = prefix ? resolve(roots[prefix], path.slice(prefix.length)) : undefined;
  if (!file?.startsWith(`${roots[prefix]}/`) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, {
    'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const u = (p) => `${base}/vendor/${p}`;
for (const theme of ['light', 'dark']) {
  writeFileSync(
    join(out, `mockup-${theme}.html`),
    `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8">
<link rel="stylesheet" href="${u('tokens.css')}"><link rel="stylesheet" href="${u('components/bundle.css')}">
<script src="${base}/ds/components/lib/react.production.min.js"></script>
<script src="${base}/ds/components/lib/react-dom.production.min.js"></script>
<script src="${u('components/bundle.js')}"></script>
<style>body{margin:0}${style}</style></head><body><div id="root"></div><script>${script}</script></body></html>`,
  );
}

const MEASURE = `() => {
  const q = (sel) => document.querySelector(sel);
  const rect = (el) => el ? (({x,y,width,height}) => ({x:Math.round(x),y:Math.round(y),w:Math.round(width),h:Math.round(height)}))(el.getBoundingClientRect()) : null;
  const css = (el, props) => el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null;
  const first = (sel) => document.querySelector(sel);
  return {
    side: { rect: rect(q('.side')), css: css(q('.side'), ['paddingTop','paddingLeft','backgroundColor','borderRightWidth']) },
    brand: { rect: rect(q('.brand')), css: css(q('.brand'), ['fontSize','fontWeight','paddingBottom']) },
    newChat: { rect: rect(first('.side .sx-btn')) },
    nav: { rect: rect(first('.sx-nav')), css: css(first('.sx-nav'), ['height','fontSize','paddingLeft']) },
    grp: { rect: rect(q('.grp')), css: css(q('.grp'), ['fontSize','letterSpacing','paddingTop','paddingLeft']) },
    me: { rect: rect(q('.me')) },
    top: { rect: rect(q('.top')), css: css(q('.top'), ['height','paddingLeft','gap','borderBottomWidth']) },
    title: { rect: rect(q('.top h2')), css: css(q('.top h2'), ['fontSize','fontWeight','lineHeight']) },
    status: { rect: rect(q('.top .sx-status, .top [class*=status]')) },
    tabs: { rect: rect(q('.top .sx-tabs')) },
    thread: { rect: rect(q('.thread')), css: css(q('.thread'), ['paddingTop','paddingLeft','maxWidth','gap']) },
    msgUser: { rect: rect(first('.sx-msg--user, .sx-msg.is-user')), css: css(first('.sx-msg__body'), ['fontSize','lineHeight','maxWidth']) },
    msgAgent: { rect: rect(document.querySelectorAll('.sx-msg')[1] ?? null) },
    tool: { rect: rect(first('.sx-tool')) },
    compose: { rect: rect(q('.compose')), css: css(q('.compose'), ['paddingLeft','paddingBottom','maxWidth']) },
    composer: { rect: rect(q('.sx-composer')), css: css(q('.sx-composer'), ['paddingTop','paddingLeft','borderRadius','maxWidth']) },
    composerModel: { rect: rect(q('.sx-composer__model')), css: css(q('.sx-composer__model'), ['fontSize','fontFamily']) },
    scrollbars: [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (s.overflowY === 'auto' || s.overflowY === 'scroll') && e.scrollHeight > e.clientHeight; }).map((e) => e.className || e.tagName),
  };
}`;

const c = await connectMcp(
  {
    id: 'pw',
    transport: 'stdio',
    command: 'npx',
    args: [
      '-y',
      '@playwright/mcp@0.0.83',
      '--headless',
      '--isolated',
      '--viewport-size',
      '1280x800',
      '--output-dir',
      out,
    ],
    env: {},
    timeoutMs: 120000,
  },
  { log: () => {} },
);
const text = (r) => (typeof r === 'string' ? r : JSON.stringify(r));
const measure = async (name, url, prepare) => {
  await c.call('browser_navigate', { url });
  await c.call('browser_wait_for', { time: 2 });
  if (prepare) await c.call('browser_evaluate', { function: prepare });
  await c.call('browser_wait_for', { time: 1 });
  console.log(
    text(await c.call('browser_take_screenshot', { filename: join(out, `${name}.png`) }))
      .slice(0, 160)
      .replace(/\n/g, ' '),
  );
  const raw = text(await c.call('browser_evaluate', { function: MEASURE }));
  // the MCP answer wraps the JSON in prose ("### Result … ### Ran Playwright code"): keep the object
  const body = raw.split('### Ran Playwright')[0];
  return JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
};
const results = {};
for (const [w, hgt] of [
  [1440, 900],
  [1180, 760],
]) {
  await c.call('browser_resize', { width: w, height: hgt });
  for (const theme of ['dark', 'light']) {
    results[`mockup-${theme}-${w}`] = await measure(
      `mockup-${theme}-${w}`,
      `${base}/out/mockup-${theme}.html`,
    );
    results[`app-${theme}-${w}`] = await measure(
      `app-${theme}-${w}`,
      appUrl,
      `() => { document.documentElement.dataset.theme = '${theme}'; const a = document.querySelector('.recent .sx-nav'); if (a) a.click(); }`,
    );
  }
}
writeFileSync(join(out, 'measures.json'), JSON.stringify(results, null, 2));
const flat = (o, p = '') =>
  Object.entries(o ?? {}).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flat(v, `${p}${k}.`)
      : [[`${p}${k}`, Array.isArray(v) ? v.join(',') : String(v)]],
  );
for (const w of [1440, 1180]) {
  const a = Object.fromEntries(flat(results[`mockup-dark-${w}`]));
  const b = Object.fromEntries(flat(results[`app-dark-${w}`]));
  console.log(
    `\n## ${w} px wide: measure | mockup | app (differences only; content-dependent widths are expected)`,
  );
  for (const k of Object.keys(a))
    if (
      !k.endsWith('.x') &&
      !k.endsWith('.y') &&
      !k.startsWith('msgAgent') &&
      !k.startsWith('tool')
    )
      if (a[k] !== b[k]) console.log(`${k} | ${a[k]} | ${b[k]}`);
}
console.log(`screenshots and measures.json in ${out}`);
await c.close();
server.close();
