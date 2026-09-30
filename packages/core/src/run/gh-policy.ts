/**
 * What a `gh` invocation may do. Reads run freely; everything that changes GitHub (a merge, a
 * review, a comment, a release, the repository, secrets, workflow runs, writing API calls) is a
 * `deploy` that needs an approval; what hands out code execution, files or the token
 * (extensions, aliases, auth, keys, gists, codespaces, the browser) is refused outright. An
 * allowlist: an unknown subcommand is a deploy, never a read.
 */
export type GhPolicy = { kind: 'read' } | { kind: 'deploy' } | { kind: 'refused'; reason: string };

/** Global flags that take a value and may come before the subcommand. */
const GLOBAL_WITH_VALUE = new Set(['-R', '--repo', '--hostname']);

const READ_ONLY: Record<string, Set<string>> = {
  pr: new Set(['view', 'diff', 'checks', 'list', 'status']),
  issue: new Set(['view', 'list', 'status']),
  repo: new Set(['view', 'list']),
  run: new Set(['view', 'list', 'watch']),
  release: new Set(['view', 'list', 'download']),
  workflow: new Set(['view', 'list']),
  label: new Set(['list']),
  gist: new Set(['view', 'list']),
  search: new Set(['issues', 'prs', 'repos', 'commits', 'code']),
  cache: new Set(['list']),
  variable: new Set(['list', 'get']),
  secret: new Set(['list']),
  project: new Set(['list', 'view', 'item-list', 'field-list']),
  org: new Set(['list']),
};
const REFUSED: Record<string, string> = {
  extension: 'gh extension installs and runs third-party code',
  alias: 'gh alias can turn a later command into a shell command',
  auth: 'gh auth would hand the token over (or change the login)',
  config: 'gh config changes how gh runs',
  'ssh-key': 'gh ssh-key adds persistent access to the account',
  'gpg-key': 'gh gpg-key adds persistent access to the account',
  codespace: 'gh codespace runs code on a remote machine with the token',
  browse: 'gh browse opens a browser',
  completion: 'gh completion writes shell code',
};
const API_WRITE_FLAGS = ['--field', '--raw-field', '--input'];

/** The policy for `gh <args>` (the program itself excluded). */
export function ghPolicy(args: string[]): GhPolicy {
  // global flags before the subcommand (`gh -R o/r pr merge 1`) do not hide the verb
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const a = args[i] as string;
    if (a === '--version' || a === '--help' || a === '-h') return { kind: 'read' };
    if (GLOBAL_WITH_VALUE.has(a)) i += 2;
    else i += 1;
  }
  const words = args.slice(i);
  const positional = words.filter((w) => !w.startsWith('-'));
  const [group = '', verb = ''] = positional;
  if (!group) return { kind: 'read' };
  if (group === 'status') return { kind: 'read' };
  if (REFUSED[group]) return { kind: 'refused', reason: REFUSED[group] as string };
  if (group === 'gist' && verb !== 'view' && verb !== 'list')
    return { kind: 'refused', reason: 'gh gist would upload files (anything on the machine)' };
  if (group === 'repo' && verb === 'deploy-key')
    return {
      kind: 'refused',
      reason: 'gh repo deploy-key adds persistent access to the repository',
    };
  if (group === 'api') {
    // GraphQL: a query reads, a mutation writes (the operation is in the `query` field)
    if (verb === 'graphql')
      return /\bmutation\b/i.test(words.join(' ')) ? { kind: 'deploy' } : { kind: 'read' };
    const method = apiMethod(words);
    const writes =
      method !== 'GET' ||
      words.some(
        (w) => /^-[fF]/.test(w) || API_WRITE_FLAGS.some((f) => w === f || w.startsWith(`${f}=`)),
      );
    return writes ? { kind: 'deploy' } : { kind: 'read' };
  }
  return READ_ONLY[group]?.has(verb) ? { kind: 'read' } : { kind: 'deploy' };
}

/** The HTTP method of `gh api`, from `-X M`, `-XM`, `--method M` or `--method=M` (default GET). */
function apiMethod(words: string[]): string {
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '-X' || w === '--method') return (words[i + 1] ?? 'GET').toUpperCase();
    if (w.startsWith('-X') && w.length > 2) return w.slice(2).toUpperCase();
    if (w.startsWith('--method=')) return w.slice('--method='.length).toUpperCase();
  }
  return 'GET';
}
