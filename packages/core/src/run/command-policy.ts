import { matchesGlob, normalize, posix } from 'node:path';
import type { ProjectFile, Role } from '@wizardingcode/shibaox-schemas';
import { hostAllowed } from '../executors/network.js';
import { ghPolicy } from './gh-policy.js';

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
  /** Whether `name` is a binary installed in the workspace (`node_modules/.bin`): `npx name` is then local. */
  localBin?: (name: string) => boolean;
}

/** Deploy-capable programs and the verbs (positional arguments) that make an invocation mutate. */
export const DEPLOY_VERBS: Record<string, string[]> = {
  vercel: ['deploy', 'redeploy', 'promote', 'rollback', 'alias', 'remove', 'rm'],
  fly: ['launch', 'deploy'],
  flyctl: ['launch', 'deploy'],
  netlify: ['deploy'],
  heroku: ['deploy', 'container:push', 'container:release', 'releases:rollback'],
  railway: ['up', 'deploy'],
  wrangler: ['deploy', 'publish'],
  kubectl: ['apply', 'create', 'replace', 'patch', 'scale', 'set', 'edit', 'delete', 'rollout'],
  terraform: ['apply', 'destroy', 'import', 'state'],
  helm: ['install', 'upgrade', 'uninstall', 'rollback'],
  npm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  pnpm: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  yarn: ['publish', 'unpublish', 'dist-tag', 'dist-tags', 'deprecate'],
  docker: ['push'],
};
/** Flags that make an otherwise read-only deploy-program invocation publish (`docker buildx build --push`). */
export const DEPLOY_FLAGS: Record<string, string[]> = { docker: ['--push'] };
/** vercel subcommands that do not deploy; any other invocation of `vercel` deploys a directory. */
export const VERCEL_READ_ONLY = [
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
];
const HELP = ['--help', '-h', '--version', '-v'];

/** Shells and interpreters whose inline-code flag runs whatever the model writes. */
const INLINE_CODE: Record<string, string[]> = {
  sh: ['-c'],
  bash: ['-c'],
  zsh: ['-c'],
  dash: ['-c'],
  fish: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  python: ['-c'],
  python3: ['-c'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
};
const ALWAYS_EXECUTE = ['sudo', 'doas'];
/** Runners that download a package and run it. */
const REMOTE_RUNNERS = ['npx', 'bunx', 'uvx'];
/** `<program> <verb>` pairs that download and run (never local). */
const REMOTE_RUNNER_VERBS: Record<string, string[]> = {
  pnpm: ['dlx'],
  yarn: ['dlx'],
  pipx: ['run'],
};
/** `<program> <verb>` pairs that run a package, local when installed. */
const EXEC_VERBS: Record<string, string[]> = { npm: ['exec'] };
const FETCHERS = ['curl', 'wget', 'http', 'https', 'xh'];
const REMOTE_SHELLS = ['ssh', 'scp', 'sftp'];

/** Where a shell-less flag cluster starts a bash/zsh command (`-lc`, `-xc`). */
const shellInline = (program: string, args: string[]): boolean =>
  args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) &&
  program in INLINE_CODE &&
  program !== 'node';

/** The package name of `npx foo@1`, `npx @scope/foo`, `npx -y foo`. */
function packageArg(args: string[]): string | undefined {
  const positional = args.find((a) => !a.startsWith('-'));
  if (!positional) return undefined;
  const scoped = positional.startsWith('@');
  const body = scoped ? positional.slice(1) : positional;
  const name = body.split('@')[0] ?? body;
  return scoped ? `@${name}` : name;
}
const binOf = (pkg: string): string => pkg.split('/').pop() ?? pkg;

function urlHosts(args: string[]): { hosts: string[]; unknown: boolean } {
  const hosts: string[] = [];
  let unknown = true;
  for (const a of args) {
    if (a.startsWith('-')) continue;
    const m = /^(?:https?|ftp):\/\/([^/?#]+)/i.exec(a);
    if (!m) continue;
    unknown = false;
    hosts.push((m[1] ?? '').replace(/^[^@]*@/, '').replace(/:\d+$/, ''));
  }
  return { hosts, unknown };
}

/**
 * The category of one command, already split into argv (no shell operators). `push` for
 * git pushes; `deploy` for publishing programs and `gh` writes; `execute` for shells and
 * interpreters given inline code, `sudo`, and runners that download code (`npx` of a package
 * that is not installed); `network` for fetchers reaching a host outside the role's
 * allowlist and for remote shells. Anything else has no category and runs when the program
 * is in the role's tools: `git status`, `gh pr view`, `kubectl get` never ask.
 */
export function classifyArgv(argv: readonly string[], ctx: ClassifyContext = {}): CommandClass {
  const [head = '', ...args] = argv;
  const program = posix.basename(head);
  const words = args.filter((w) => !w.startsWith('-'));
  if (program === 'git')
    return {
      program,
      ...(args.includes('push') || args.includes('send-pack') ? { category: 'push' } : {}),
    };
  if (program === 'gh') {
    const p = ghPolicy([...args]);
    if (p.kind === 'refused') return { program, refused: p.reason };
    return { program, ...(p.kind === 'deploy' ? { category: 'deploy' } : {}) };
  }
  if (ALWAYS_EXECUTE.includes(program)) return { program, category: 'execute' };
  const inline = INLINE_CODE[program];
  if (inline && (args.some((a) => inline.includes(a)) || shellInline(program, args)))
    return { program, category: 'execute' };
  if (REMOTE_RUNNER_VERBS[program]?.includes(words[0] ?? ''))
    return { program, category: 'execute' };
  if (REMOTE_RUNNERS.includes(program) || EXEC_VERBS[program]?.includes(words[0] ?? '')) {
    const pkg = packageArg(REMOTE_RUNNERS.includes(program) ? args : words.slice(1));
    const local = pkg !== undefined && (ctx.localBin?.(binOf(pkg)) ?? false);
    return local ? { program } : { program, category: 'execute' };
  }
  if (FETCHERS.includes(program)) {
    const { hosts, unknown } = urlHosts(args);
    const allow = ctx.network ?? [];
    const ok = !unknown && hosts.every((h) => hostAllowed(h, allow));
    return ok ? { program } : { program, category: 'network' };
  }
  if (REMOTE_SHELLS.includes(program)) return { program, category: 'network' };
  if (program === 'rsync' && words.some((w) => /^[^/]+:/.test(w) && !/^[a-zA-Z]:\\/.test(w)))
    return { program, category: 'network' };
  const verbs = DEPLOY_VERBS[program];
  if (verbs) {
    const deploys =
      words.some((w) => verbs.includes(w)) ||
      args.some((w) => DEPLOY_FLAGS[program]?.includes(w)) ||
      (program === 'vercel' &&
        (words.length === 0
          ? !args.some((w) => HELP.includes(w))
          : !VERCEL_READ_ONLY.includes(words[0] as string)));
    return { program, ...(deploys ? { category: 'deploy' } : {}) };
  }
  return { program };
}

/** The globs a run must not change: the role's plus the project's (`shibaox.yaml protected`). */
export function protectedGlobs(
  role: Pick<Role, 'permissions'>,
  project?: Pick<ProjectFile, 'protected'>,
): string[] {
  return [...role.permissions.protected, ...(project?.protected ?? [])];
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
    const glob = g.replace(/^(\.\/)+/, '');
    const dirGlob = glob.endsWith('/**') ? glob.slice(0, -3) : undefined;
    return candidates.some((c) => matchesGlob(c, glob) || (dirGlob !== undefined && c === dirGlob));
  });
}
