import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path';
import type { ProjectFile, Role } from '@wizardingcode/shibaox-schemas';
import picomatch from 'picomatch';
import { hostAllowed } from '../executors/network.js';
import { ghPolicy } from './gh-policy.js';
import { analyseGitArgs } from './git-policy.js';

/** What a command (or a file write) means, when it needs a human before it runs. */
export type ApprovalCategory = 'push' | 'deploy' | 'execute' | 'network' | 'protected';
export const APPROVAL_CATEGORIES: readonly ApprovalCategory[] = [
  'push',
  'deploy',
  'execute',
  'network',
  'protected',
];

export interface CommandClass {
  program: string;
  category?: ApprovalCategory;
  /** Set when the command is never run, whatever the role says (e.g. `gh auth`). */
  refused?: string;
}

export interface ClassifyContext {
  /** `permissions.network` of the role: hosts a fetcher may reach without asking. */
  network?: readonly string[];
  /**
   * Whether a package spec (`tsc`, `@scope/name`) is installed in the workspace: its bin in
   * `node_modules/.bin`, or its directory under `node_modules`. `npx <spec>` is then local.
   */
  localBin?: (spec: string) => boolean;
  /** `VAR=value` prefixes the caller already stripped (git refuses GIT_* and aliases). */
  assignments?: readonly string[];
}

/**
 * Deploy programs whose read-only invocations are listed: anything else they do deploys. A
 * phrase with a space names a subcommand (`config show`); a bare word covers the verb alone
 * and, for `fly config`-style tools, only when it is the whole command.
 */
export const DEPLOY_READ_ONLY: Record<string, string[]> = {
  vercel: [
    'env',
    'ls',
    'list',
    'logs',
    'inspect',
    'whoami',
    'login',
    'logout',
    'help',
    'pull',
    'link',
    'dev',
    'build',
    'domains',
    'dns',
    'certs',
    'projects',
    'project',
    'teams',
    'switch',
  ],
  fly: [
    'status',
    'logs',
    'releases',
    'version',
    'help',
    'info',
    'doctor',
    'platform',
    'dashboard',
    'apps list',
    'config show',
    'config validate',
    'machines list',
    'machines status',
    'secrets list',
    'ips list',
    'certs list',
    'volumes list',
    'auth whoami',
    'auth token',
  ],
  flyctl: [
    'status',
    'logs',
    'releases',
    'version',
    'help',
    'info',
    'doctor',
    'platform',
    'dashboard',
    'apps list',
    'config show',
    'config validate',
    'machines list',
    'machines status',
    'secrets list',
    'ips list',
    'certs list',
    'volumes list',
    'auth whoami',
    'auth token',
  ],
  netlify: ['status', 'help', 'logs', 'open', 'sites:list', 'sites list', 'env:list', 'env list'],
  heroku: [
    'apps',
    'apps:info',
    'info',
    'logs',
    'ps',
    'releases',
    'releases:info',
    'config',
    'config:get',
    'whoami',
    'auth:whoami',
    'version',
    'help',
    'status',
    'domains',
    'addons',
    'regions',
    'pg:info',
    'access',
  ],
  railway: [
    'status',
    'logs',
    'whoami',
    'list',
    'environment',
    'variables',
    'version',
    'help',
    'open',
    'service',
    'docs',
  ],
  wrangler: [
    'whoami',
    'version',
    'help',
    'tail',
    'dev',
    'login',
    'logout',
    'types',
    'check',
    'kv namespace list',
    'kv key list',
    'kv:namespace list',
    'kv:key list',
    'secret list',
    'deployments list',
    'deployments status',
    'd1 list',
    'r2 bucket list',
    'pages project list',
    'pages deployment list',
  ],
  kubectl: [
    'get',
    'describe',
    'logs',
    'explain',
    'version',
    'api-resources',
    'api-versions',
    'top',
    'diff',
    'cluster-info',
    'events',
    'wait',
    'options',
    'help',
    'config view',
    'config current-context',
    'config get-contexts',
    'auth can-i',
    'auth whoami',
    'rollout status',
    'rollout history',
  ],
  terraform: [
    'plan',
    'show',
    'validate',
    'fmt',
    'init',
    'version',
    'output',
    'providers',
    'graph',
    'console',
    'help',
    'get',
    'state list',
    'state show',
    'workspace list',
    'workspace show',
  ],
  helm: [
    'list',
    'ls',
    'status',
    'get',
    'show',
    'search',
    'template',
    'lint',
    'version',
    'help',
    'history',
    'env',
    'verify',
    'pull',
    'repo list',
    'dependency list',
    'plugin list',
  ],
};
/** General tools with a few publishing verbs (everything else they do is ordinary). */
export const DEPLOY_VERBS: Record<string, string[]> = {
  npm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  pnpm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  yarn: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  docker: ['push'],
};
/** Flags that make an otherwise read-only invocation publish (`docker buildx build --push`). */
export const DEPLOY_FLAGS: Record<string, string[]> = { docker: ['--push'] };
const HELP = ['--help', '-h', '--version', '-v', 'help', 'version'];

/** Interpreters and their inline-code flags: short letters (clusters allowed) and long forms. */
const INLINE_CODE: Record<string, { short: string; long: string[] }> = {
  sh: { short: 'c', long: [] },
  bash: { short: 'c', long: [] },
  zsh: { short: 'c', long: [] },
  dash: { short: 'c', long: [] },
  fish: { short: 'c', long: ['--command'] },
  node: { short: 'ep', long: ['--eval', '--print'] },
  python: { short: 'c', long: [] },
  ruby: { short: 'e', long: [] },
  perl: { short: 'eE', long: [] },
  php: { short: 'rRBEF', long: [] },
  bun: { short: 'ep', long: ['--eval', '--print'] },
  tsx: { short: 'e', long: ['--eval'] },
  'ts-node': { short: 'e', long: ['--eval'] },
};
/** node/bun/deno preload flags whose `data:` value is inline code. */
const PRELOAD_FLAGS = ['--import', '--require', '-r', '--preload'];
const ALWAYS_EXECUTE = ['sudo', 'doas'];
/** Runners that download a package and run it (local when the package is installed). */
const REMOTE_RUNNERS = ['npx', 'bunx'];
/** `<program> <verb>`: always downloads and runs. */
const REMOTE_RUNNER_VERBS: Record<string, string[]> = {
  pnpm: ['dlx', 'create'],
  yarn: ['dlx', 'create'],
  npm: ['create'],
  bun: ['x', 'create'],
  pipx: ['run'],
  deno: ['eval'],
};
/** `<program> <verb> <spec>`: runs a package, local when installed. */
const EXEC_VERBS: Record<string, string[]> = { npm: ['exec', 'x'] };
const FETCHERS = ['curl', 'wget', 'http', 'https', 'xh'];
/** Fetcher options whose value is a file or address, not a URL to check. */
const FETCHER_VALUE_OPTS = new Set([
  '-o',
  '--output',
  '-H',
  '--header',
  '-d',
  '--data',
  '--data-raw',
  '--data-binary',
  '--data-urlencode',
  '-X',
  '--request',
  '-u',
  '--user',
  '-A',
  '--user-agent',
  '-e',
  '--referer',
  '-b',
  '--cookie',
  '-c',
  '--cookie-jar',
  '-T',
  '--upload-file',
  '-w',
  '--write-out',
  '-m',
  '--max-time',
  '--retry',
  '-F',
  '--form',
  '--cacert',
  '--cert',
  '--key',
  '--output-dir',
  '-r',
  '--range',
  '--connect-timeout',
  '--max-redirs',
  '-O',
  '-P',
  '--directory-prefix',
  '-U',
  '-t',
  '--tries',
  '-T',
  '--timeout',
  '--password',
  '--http-user',
  '--http-password',
  '--limit-rate',
  '-j',
  '--json',
  '-a',
  '--auth',
]);
/** Fetcher options that point elsewhere than the URLs on the line: always a question. */
const FETCHER_INDIRECT = [
  '-K',
  '--config',
  '-i',
  '--input-file',
  '-x',
  '--proxy',
  '--resolve',
  '--connect-to',
  '--proxy1',
  '--socks5',
  '--socks4',
  '--interface',
  '--unix-socket',
  '--abstract-unix-socket',
];
const REMOTE_SHELLS = ['ssh', 'scp', 'sftp'];
const ALLOWED_SCHEMES = ['http', 'https', 'ftp'];
const HOSTLIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i;

/**
 * Every program the policy looks inside: Claude Code never gives these a blanket allow rule,
 * so each call reaches `canUseTool` and is classified like on the direct adapter.
 */
export const POLICY_PROGRAMS: readonly string[] = [
  'git',
  'gh',
  ...Object.keys(DEPLOY_READ_ONLY),
  ...Object.keys(DEPLOY_VERBS),
  ...Object.keys(INLINE_CODE),
  'python3',
  ...ALWAYS_EXECUTE,
  ...REMOTE_RUNNERS,
  ...Object.keys(REMOTE_RUNNER_VERBS),
  'uvx',
  ...FETCHERS,
  ...REMOTE_SHELLS,
  'rsync',
  'env',
];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The program name the policy judges: `python3.12` → `python`, `/usr/bin/node` → `node`. */
function programKey(head: string): string {
  const base = posix.basename(head);
  return /^python[0-9.]*$/.test(base) ? 'python' : base;
}

function inlineCode(program: string, args: readonly string[]): boolean {
  const spec = INLINE_CODE[program];
  if (!spec) return false;
  for (const a of args) {
    if (spec.long.some((l) => a === l || a.startsWith(`${l}=`))) return true;
    if (/^-[A-Za-z]+$/.test(a) && [...a.slice(1)].some((ch) => spec.short.includes(ch)))
      return true;
  }
  return false;
}

function preloadsData(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const [flag, inlineValue] = a.includes('=')
      ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
      : [a, undefined];
    if (!PRELOAD_FLAGS.includes(flag)) continue;
    const value = inlineValue ?? args[i + 1] ?? '';
    if (/^data:/i.test(value)) return true;
  }
  return false;
}

/** The package spec `npx` would run: the first positional, unless `--package`/`-p` points elsewhere. */
function packageSpec(args: readonly string[]): { spec?: string; elsewhere: boolean } {
  let elsewhere = false;
  let spec: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      spec ??= args[i + 1];
      break;
    }
    if (a === '-p' || a === '--package') {
      elsewhere = true;
      i++;
      continue;
    }
    if (a.startsWith('--package=') || a.startsWith('-p=')) {
      elsewhere = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    spec = a;
    break;
  }
  return { spec, elsewhere };
}

/** A bare package spec: a name or `@scope/name`, no version, no URL, no shorthand. */
function bareSpec(spec: string): boolean {
  return /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(spec);
}

function fetcherClass(
  program: string,
  args: readonly string[],
  allow: readonly string[],
): CommandClass {
  const hosts: string[] = [];
  let indirect = false;
  let sawUrl = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    const name = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    const inlineValue = name !== a ? a.slice(a.indexOf('=') + 1) : undefined;
    if (FETCHER_INDIRECT.includes(name)) {
      indirect = true;
      if (inlineValue === undefined) i++;
      continue;
    }
    if (name === '--url') {
      const v = inlineValue ?? args[++i] ?? '';
      const h = hostOf(v);
      if (!h) return { program, category: 'network' };
      hosts.push(h);
      sawUrl = true;
      continue;
    }
    if (a.startsWith('-')) {
      if (FETCHER_VALUE_OPTS.has(name) && inlineValue === undefined) i++;
      continue;
    }
    const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(a);
    if (m) {
      if (!ALLOWED_SCHEMES.includes((m[1] ?? '').toLowerCase()))
        return { program, category: 'network' };
      const h = hostOf(a);
      if (!h) return { program, category: 'network' };
      hosts.push(h);
      sawUrl = true;
      continue;
    }
    // a bare word that looks like a host (`evil.com`, `evil.com/x`) is a target too
    if (HOSTLIKE.test(a)) {
      hosts.push(a.replace(/[/:].*$/, ''));
      sawUrl = true;
    }
  }
  if (indirect || !sawUrl) return { program, category: 'network' };
  return hosts.every((h) => hostAllowed(h, allow)) ? { program } : { program, category: 'network' };
}

function hostOf(url: string): string | undefined {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  if (!m) return undefined;
  return (m[1] ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, '') || undefined;
}

/**
 * The category of one command, already split into argv (no shell operators). `push` for
 * git pushes; `deploy` for publishing programs and `gh` writes; `execute` for shells and
 * interpreters given inline code, `sudo`, and runners that download code (`npx` of a package
 * that is not installed); `network` for fetchers reaching a host outside the role's
 * allowlist and for remote shells. Anything else has no category and runs when the program
 * is in the role's tools: `git status`, `gh pr view`, `kubectl get` never ask. `VAR=value`
 * prefixes and a leading `env` are unwrapped first.
 */
export function classifyArgv(argv: readonly string[], ctx: ClassifyContext = {}): CommandClass {
  const assignments = [...(ctx.assignments ?? [])];
  let i = 0;
  while (i < argv.length && ASSIGNMENT.test(argv[i] ?? '')) assignments.push(argv[i++] ?? '');
  if (posix.basename(argv[i] ?? '') === 'env') {
    i++;
    while (i < argv.length && ASSIGNMENT.test(argv[i] ?? '')) assignments.push(argv[i++] ?? '');
  }
  const head = argv[i] ?? '';
  const args = argv.slice(i + 1);
  const program = programKey(head);
  const words = args.filter((w) => !w.startsWith('-'));
  const phrase = (n: number) => words.slice(0, n).join(' ');
  if (program === 'git') {
    const v = analyseGitArgs(args, assignments);
    return v.refused
      ? { program, refused: v.refused }
      : { program, ...(v.category ? { category: v.category } : {}) };
  }
  if (program === 'gh') {
    const p = ghPolicy([...args]);
    if (p.kind === 'refused') return { program, refused: p.reason };
    return { program, ...(p.kind === 'deploy' ? { category: 'deploy' } : {}) };
  }
  if (ALWAYS_EXECUTE.includes(program)) return { program, category: 'execute' };
  if (inlineCode(program, args)) return { program, category: 'execute' };
  if ((program === 'node' || program === 'bun' || program === 'deno') && preloadsData(args))
    return { program, category: 'execute' };
  if (REMOTE_RUNNER_VERBS[program]?.includes(words[0] ?? ''))
    return { program, category: 'execute' };
  if (program === 'npm' && words[0] === 'init' && words[1] !== undefined)
    return { program, category: 'execute' };
  if (program === 'uvx') return { program, category: 'execute' };
  const runner = REMOTE_RUNNERS.includes(program);
  if (runner || EXEC_VERBS[program]?.includes(words[0] ?? '')) {
    const { spec, elsewhere } = packageSpec(
      runner ? args : args.slice(args.indexOf(words[0] ?? '') + 1),
    );
    const local =
      !elsewhere && spec !== undefined && bareSpec(spec) && (ctx.localBin?.(spec) ?? false);
    return local ? { program } : { program, category: 'execute' };
  }
  if (FETCHERS.includes(program)) return fetcherClass(program, args, ctx.network ?? []);
  if (REMOTE_SHELLS.includes(program)) return { program, category: 'network' };
  if (program === 'rsync' && words.some((w) => /^[^/]+:/.test(w) && !/^[a-zA-Z]:\\/.test(w)))
    return { program, category: 'network' };
  const readOnly = DEPLOY_READ_ONLY[program];
  if (readOnly) {
    const helpOnly = args.length > 0 && args.every((a) => HELP.includes(a));
    const listed =
      readOnly.includes(phrase(2)) ||
      readOnly.includes(phrase(1)) ||
      (words.length === 0 ? false : HELP.includes(words[0] ?? ''));
    // a bare deploy program call (`vercel`) deploys; a bare `--help` does not
    const deploys = words.length === 0 ? !helpOnly : !listed;
    return { program, ...(deploys ? { category: 'deploy' } : {}) };
  }
  const verbs = DEPLOY_VERBS[program];
  if (verbs) {
    const deploys =
      words.some((w) => verbs.includes(w)) || args.some((w) => DEPLOY_FLAGS[program]?.includes(w));
    return { program, ...(deploys ? { category: 'deploy' } : {}) };
  }
  return { program };
}

/** The globs a run must not change: the role's plus the project's (`shibaox.yaml protected`). */
export function protectedGlobs(
  role: Pick<Role, 'permissions'>,
  project?: Pick<ProjectFile, 'protected'>,
): string[] {
  return [...new Set([...role.permissions.protected, ...(project?.protected ?? [])])];
}

const NOCASE = process.platform === 'darwin' || process.platform === 'win32';

/** One glob as a matcher over workspace-relative posix paths (dotfiles included, bare patterns at any depth). */
function matcher(glob: string): (rel: string) => boolean {
  let g = glob
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
  if (g.endsWith('/')) g = `${g}**`;
  const isMatch = picomatch(g, { dot: true, nocase: NOCASE, basename: !g.includes('/') });
  const dir = g.endsWith('/**') ? g.slice(0, -3) : undefined;
  const dirMatch = dir === undefined ? undefined : picomatch(dir, { dot: true, nocase: NOCASE });
  return (rel) => isMatch(rel) || (dirMatch?.(rel) ?? false);
}

/** Whether a path (relative to the workspace root) is protected: itself, or a parent of it. */
export function isProtected(relPath: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const rel = normalize(relPath)
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/$/, '');
  const parts = rel.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  return globs.some((g) => {
    const m = matcher(g);
    return candidates.some((c) => m(c));
  });
}

/** The deepest existing ancestor resolved through symlinks, with the rest appended. */
function realish(p: string): string {
  let probe = p;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return p;
      tail.unshift(probe.slice(parent.length + 1));
      probe = parent;
    }
  }
  try {
    return join(realpathSync.native(probe), ...tail);
  } catch {
    return p;
  }
}

/**
 * Whether a file inside the workspace is protected, judged on every spelling of its path:
 * as given (relative to the root), and through symlinks and the filesystem's own case.
 */
export function isProtectedPath(root: string, target: string, globs: readonly string[]): boolean {
  if (globs.length === 0) return false;
  const abs = isAbsolute(target) ? target : resolve(root, target);
  const spellings = [relative(resolve(root), abs), relative(realish(resolve(root)), realish(abs))];
  return spellings.some(
    (rel) => rel && !rel.startsWith(`..${sep}`) && rel !== '..' && isProtected(rel, globs),
  );
}

/** For callers with a workspace: `localBin` over `node_modules` (bin or package directory). */
export function workspaceLocalBin(workspace: string): (spec: string) => boolean {
  return (spec) => {
    if (!bareSpec(spec)) return false;
    if (spec.startsWith('@'))
      return existsSync(join(workspace, 'node_modules', ...spec.split('/')));
    return (
      existsSync(join(workspace, 'node_modules', '.bin', spec)) ||
      existsSync(join(workspace, 'node_modules', spec))
    );
  };
}
