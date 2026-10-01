/** The extension a fenced block's language usually gets. */
const EXT: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'md',
  md: 'md',
  html: 'html',
  xml: 'xml',
  css: 'css',
  sql: 'sql',
  go: 'go',
  php: 'php',
  csv: 'csv',
  tsv: 'tsv',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'Dockerfile',
  toml: 'toml',
  text: 'txt',
  txt: 'txt',
};

/** What a nameless block of each kind is called. */
const PLAIN: Record<string, string> = {
  csv: 'table',
  tsv: 'table',
  md: 'notes',
  json: 'data',
  yaml: 'config',
  toml: 'config',
  sh: 'script',
  sql: 'query',
  html: 'page',
  css: 'styles',
  diff: 'changes',
};

const FILE_RE = /[\w.-]+\.[A-Za-z0-9]{1,8}/;

/**
 * A file name for a code block: one written in the fence info (```js fibonacci.js, title="x.ts"),
 * else a `file:` comment on the first line, else the first function or class with the
 * language's extension, else a plain name per kind (table.csv, notes.md, snippet.txt).
 */
export function suggestName(text: string, lang: string | undefined, info?: string): string {
  const l = (lang ?? '').toLowerCase();
  const ext = EXT[l] ?? (l || 'txt');
  const fromInfo = info
    ?.split(/\s+/)
    .slice(1)
    .map((w) => w.replace(/^[a-z]+=/i, '').replace(/^["']|["']$/g, ''))
    .find((w) => FILE_RE.test(w) && !/^\d/.test(w));
  if (fromInfo) return base(fromInfo);
  const first = text.split('\n')[0] ?? '';
  const comment = first.match(/^\s*(?:\/\/|#|--|\/\*|<!--)\s*file\s*:\s*(\S+)/i);
  if (comment?.[1]) return base(comment[1].replace(/\*\/|-->/g, ''));
  const named = text.match(
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|def|const|let|var)\s+([A-Za-z_$][\w$]*)/m,
  );
  if (named?.[1] && ['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'php'].includes(ext))
    return `${named[1]}.${ext}`;
  if (ext === 'Dockerfile') return 'Dockerfile';
  return `${PLAIN[ext] ?? 'snippet'}.${ext}`;
}

const base = (p: string): string => p.split('/').pop() ?? p;
