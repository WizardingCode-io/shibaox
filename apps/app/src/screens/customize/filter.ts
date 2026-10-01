/** Every word of the query appears in one of the fields (case-insensitive); an empty query matches. */
export function matches(query: string, fields: (string | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The rows whose category is the one picked (`undefined`: all of them). */
export function inCategory<T>(
  rows: T[],
  category: string | undefined,
  of: (row: T) => string[],
): T[] {
  return category ? rows.filter((r) => of(r).includes(category)) : rows;
}

/** Splits "a, b c" into ["a", "b", "c"]. */
export const words = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter(Boolean);

/** "Name: value" lines into a headers object (lines without a colon are skipped). */
export function headerLines(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/** `owner/repo[/path]` → repo and path; a URL or an absolute path stays whole. */
export function splitRepo(input: string): { repo: string; path?: string } {
  const s = input.trim().replace(/\/+$/, '');
  if (/^([a-z][a-z0-9+.-]*:|\/)/i.test(s)) return { repo: s };
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return { repo: parts.join('/') };
  return { repo: parts.slice(0, 2).join('/'), path: parts.slice(2).join('/') };
}

/**
 * Why the daemon would refuse a repository (its `repoUrl`): `owner/repo` (with an optional
 * path after it), an `https://` git URL, or, for a daemon on this machine only, a `file://`
 * URL or an absolute path. Undefined when it is fine.
 */
export function repoProblem(input: string, local: boolean): string | undefined {
  const { repo } = splitRepo(input);
  if (!repo) return 'A repository is needed';
  if (/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*$/i.test(repo)) return undefined;
  if (/^https:\/\/[^\s@]+$/.test(repo)) return undefined;
  if (/^file:\/\/\/\S+$/.test(repo) || repo.startsWith('/'))
    return local ? undefined : 'A file URL or a path works with a daemon on this machine only';
  return 'owner/repo or an https git URL';
}

/** Ids as the schemas accept them. */
export const ID_RE = /^[a-z0-9][a-z0-9:_-]*$/i;
