import { basename } from 'node:path';

export type ApprovalCategory = 'push' | 'deploy';
export type ToolCategory = ApprovalCategory | 'other';
export type BashAnalysis =
  | { ok: true; program: string; category: ToolCategory; argv: string[] }
  | { ok: false; reason: string };

export const COMPOUND_REASON = 'compound commands are not allowed; run one command per call';

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
const DEPLOY_FLAGS: Record<string, string[]> = { docker: ['--push'] };
/** vercel subcommands that do not deploy; any other invocation of `vercel` deploys a directory. */
const VERCEL_READ_ONLY = [
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
/**
 * `gh` invocations that change something on GitHub for good: a merge, a release, the
 * repository itself, secrets, a workflow dispatch, a writing API call. Reading, reviewing and
 * commenting are not gated.
 */
export const GH_DEPLOY: Record<string, string[]> = {
  pr: ['merge', 'close', 'lock'],
  release: ['create', 'delete', 'upload', 'edit', 'delete-asset'],
  repo: ['delete', 'edit', 'create', 'archive', 'rename', 'unarchive', 'sync', 'set-default'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete', 'remove'],
  workflow: ['run', 'enable', 'disable'],
  ruleset: ['create', 'delete', 'edit'],
  label: ['create', 'delete', 'edit', 'clone'],
};
const GH_API_WRITE_FLAGS = ['-f', '-F', '--field', '--raw-field', '--input'];

/** Whether a `gh` argv (without the program) deploys. */
export function ghDeploys(words: string[]): boolean {
  const positional = words.filter((w) => !w.startsWith('-'));
  const [group = '', verb = ''] = positional;
  if (group === 'api') {
    const i = words.findIndex((w) => w === '-X' || w === '--method' || w.startsWith('--method='));
    const method = i < 0 ? 'GET' : (words[i]?.split('=')[1] ?? words[i + 1] ?? 'GET').toUpperCase();
    if (method !== 'GET') return true;
    return words.some(
      (w) =>
        GH_API_WRITE_FLAGS.includes(w) || w.startsWith('--field=') || w.startsWith('--raw-field='),
    );
  }
  return GH_DEPLOY[group]?.includes(verb) ?? false;
}

/** Programs that never get a blanket allow rule: every call goes through `canUseTool`. */
export const GATED_PROGRAMS = ['git', 'gh', ...Object.keys(DEPLOY_VERBS)];

// Command separators, pipes, substitutions and backgrounding (`&` but not `2>&1` / `&>`).
const COMPOUND = /;|&&|\||`|\$\(|[<>]\(|\n|\r|(?<![<>])&(?!>)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** git global options without a value; any global option not listed here is refused. */
const GIT_FLAGS = [
  '--no-pager',
  '-p',
  '--paginate',
  '-P',
  '--bare',
  '--no-replace-objects',
  '--no-lazy-fetch',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
  '--no-advice',
  '--exec-path',
  '--html-path',
  '--man-path',
  '--info-path',
  '--version',
  '--help',
  '-h',
  '-v',
];
/** git global options taking one value (`--opt value`, or `--opt=value` for the long ones). */
const GIT_OPTS_WITH_VALUE = ['-C', '--git-dir', '--work-tree', '--namespace'];
/**
 * git subcommands that may run; anything else (a user alias from `~/.gitconfig`, an external
 * `git-<name>` program, a command runner such as `filter-branch` or `mergetool`) is refused.
 */
const GIT_SUBCOMMANDS = new Set(
  (
    'add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore ' +
    'check-mailmap check-ref-format checkout checkout-index cherry cherry-pick clean clone commit ' +
    'commit-graph commit-tree config count-objects describe diff diff-files diff-index diff-tree ' +
    'difftool fetch for-each-ref format-patch fsck gc grep hash-object help init lfs log ' +
    'ls-files ls-remote ls-tree maintenance merge merge-base merge-file merge-tree mv name-rev ' +
    'notes pull push range-diff read-tree rebase reflog remote repack replace reset restore ' +
    'rev-list rev-parse revert rm send-pack shortlog show show-branch show-ref sparse-checkout ' +
    'stash status submodule subtree switch symbolic-ref tag update-index update-ref var ' +
    'verify-commit verify-tag version whatchanged worktree write-tree'
  ).split(' '),
);
/** Subcommand options that make git run another program or load hooks/config. */
const GIT_RUNNER_OPTS =
  /^--(upload-pack|receive-pack|exec|extcmd|config|template|open-files-in-pager)(=|$)/;
/** Short options that take a command; `-O<cmd>` may be bundled, so these match by prefix. */
const GIT_RUNNER_SHORT: Record<string, string[]> = {
  rebase: ['-x'],
  difftool: ['-x'],
  clone: ['-u', '-c'],
  grep: ['-O'],
};
const GIT_RUNNER_WORDS: Record<string, string> = { submodule: 'foreach', bisect: 'run' };
const GIT_CONFIG_READ = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'];
const GIT_CONFIG_WRITE = [
  '--add',
  '--unset',
  '--unset-all',
  '--replace-all',
  '--rename-section',
  '--remove-section',
  '--edit',
  '-e',
];
const HELP = ['--help', '-h', '--version', '-v'];

interface Token {
  text: string;
  /** The shell would expand it: `$` outside single quotes, or an unquoted `{ * ? [` or leading `~`. */
  expands: boolean;
}

/** Splits a simple command the way a POSIX shell would (quotes and backslashes). */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let cur: Token | undefined;
  let quote: "'" | '"' | undefined;
  const push = (ch: string, expandable: boolean, unquoted = false) => {
    cur ??= { text: '', expands: false };
    const starts = cur.text === '';
    cur.text += ch;
    if (ch === '$' && expandable) cur.expands = true;
    if (unquoted && ('{*?['.includes(ch) || (ch === '~' && starts))) cur.expands = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else push(ch, false);
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === '\\' && i + 1 < command.length) push(command[++i] as string, false);
      else push(ch, true);
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur ??= { text: '', expands: false };
    } else if (ch === '\\' && i + 1 < command.length) push(command[++i] as string, false);
    else if (/\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = undefined;
    } else push(ch, true, true);
  }
  if (quote) return undefined;
  if (cur) tokens.push(cur);
  return tokens;
}

function analyseGit(args: Token[], assignments: string[]): BashAnalysis {
  const argv = ['git', ...args.map((t) => t.text)];
  const refuse = (reason: string): BashAnalysis => ({ ok: false, reason });
  if (assignments.some((a) => /^GIT_/i.test(a) && !/^GIT_(AUTHOR|COMMITTER)_/.test(a)))
    return refuse('configuring git through the environment is not allowed');
  if (assignments.some((a) => /alias\./i.test(a)))
    return refuse('defining git aliases is not allowed');
  let j = 0;
  while (j < args.length && args[j]?.text.startsWith('-')) {
    const opt = args[j]?.text ?? '';
    const name = opt.startsWith('--') ? (opt.split('=')[0] as string) : opt;
    if (opt === '-c' || name === '--config-env')
      return refuse('setting git config on the command line is not allowed');
    if (GIT_FLAGS.includes(opt)) j += 1;
    else if (GIT_OPTS_WITH_VALUE.includes(opt)) j += 2;
    else if (name !== opt && GIT_OPTS_WITH_VALUE.includes(name)) j += 1;
    else return refuse(`git option "${name}" is not allowed`);
  }
  const sub = args[j]?.text;
  const rest = args.slice(j + 1).map((t) => t.text);
  if (sub === undefined) return { ok: true, program: 'git', category: 'other', argv };
  if (!GIT_SUBCOMMANDS.has(sub)) return refuse(`git subcommand "${sub}" is not allowed`);
  if (sub === 'push' || sub === 'send-pack')
    return { ok: true, program: 'git', category: 'push', argv };
  if ((sub === 'subtree' || sub === 'lfs') && rest.includes('push'))
    return { ok: true, program: 'git', category: 'push', argv };
  if (
    rest.some(
      (a) => GIT_RUNNER_OPTS.test(a) || GIT_RUNNER_SHORT[sub]?.some((o) => a.startsWith(o)),
    ) ||
    (GIT_RUNNER_WORDS[sub] !== undefined && rest.includes(GIT_RUNNER_WORDS[sub] as string))
  )
    return refuse(`git ${sub} with an option that runs other programs is not allowed`);
  if (sub === 'config') {
    const reads =
      rest[0] === 'get' || rest[0] === 'list' || rest.some((a) => GIT_CONFIG_READ.includes(a));
    const writes = rest.some((a) => GIT_CONFIG_WRITE.includes(a));
    if (!reads || writes) return refuse('changing git config is not allowed');
  }
  return { ok: true, program: 'git', category: 'other', argv };
}

/**
 * Parses one Bash command: rejects compound commands, finds the program (after `VAR=val`
 * prefixes and a leading `env`), and classifies git pushes and deploy-program invocations.
 */
export function analyseBashCommand(command: string): BashAnalysis {
  if (COMPOUND.test(command)) return { ok: false, reason: COMPOUND_REASON };
  const tokens = tokenize(command.trim());
  if (!tokens) return { ok: false, reason: 'unbalanced quotes' };
  const assignments: string[] = [];
  let i = 0;
  const skipAssignments = () => {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i]?.text ?? ''))
      assignments.push(tokens[i++]?.text ?? '');
  };
  skipAssignments();
  if (tokens[i] && basename(tokens[i]?.text ?? '') === 'env') {
    i++;
    for (;;) {
      skipAssignments();
      const t = tokens[i]?.text;
      if (t === undefined || !t.startsWith('-')) break;
      if (t.startsWith('-S') || t.startsWith('--split-string'))
        return { ok: false, reason: 'env -S is not allowed' };
      i += ['-u', '--unset', '-C', '--chdir'].includes(t) ? 2 : 1;
    }
  }
  const head = tokens[i];
  if (!head) return { ok: false, reason: 'empty command' };
  const program = basename(head.text);
  const args = tokens.slice(i + 1);
  const argv = [head.text, ...args.map((t) => t.text)];
  const gated = GATED_PROGRAMS.includes(program);
  if (gated && head.text !== program)
    return { ok: false, reason: `run ${program} by name, not by path (${head.text})` };
  if (gated && (head.expands || args.some((t) => t.expands)))
    return { ok: false, reason: `shell expansion is not allowed in ${program} commands` };
  if (program === 'git') return analyseGit(args, assignments);
  if (program === 'gh')
    return {
      ok: true,
      program,
      category: ghDeploys(args.map((t) => t.text)) ? 'deploy' : 'other',
      argv,
    };
  const verbs = DEPLOY_VERBS[program];
  if (verbs) {
    const words = args.map((t) => t.text);
    const positional = words.filter((w) => !w.startsWith('-'));
    const deploys =
      positional.some((w) => verbs.includes(w)) ||
      words.some((w) => DEPLOY_FLAGS[program]?.includes(w)) ||
      // `vercel`, `vercel ./dir`, `vercel --prod` deploy; only its read-only subcommands do not.
      (program === 'vercel' &&
        (positional.length === 0
          ? !words.some((w) => HELP.includes(w))
          : !VERCEL_READ_ONLY.includes(positional[0] as string)));
    return { ok: true, program, category: deploys ? 'deploy' : 'other', argv };
  }
  return { ok: true, program, category: 'other', argv };
}
