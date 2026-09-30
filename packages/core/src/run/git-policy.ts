/**
 * What a `git` invocation may do, shared by both runtimes: a subcommand allowlist (no user
 * aliases, no external `git-<name>` programs, no command runners), no config on the command
 * line or through the environment, and `push` as the one category.
 */
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

export interface GitVerdict {
  refused?: string;
  category?: 'push';
}

/** The verdict on `git <args>` run with `VAR=value` prefixes (`assignments`). */
export function analyseGitArgs(
  args: readonly string[],
  assignments: readonly string[] = [],
): GitVerdict {
  const refuse = (reason: string): GitVerdict => ({ refused: reason });
  if (assignments.some((a) => /^GIT_/i.test(a) && !/^GIT_(AUTHOR|COMMITTER)_/.test(a)))
    return refuse('configuring git through the environment is not allowed');
  if (assignments.some((a) => /alias\./i.test(a)))
    return refuse('defining git aliases is not allowed');
  let j = 0;
  while (j < args.length && (args[j] ?? '').startsWith('-')) {
    const opt = args[j] ?? '';
    const name = opt.startsWith('--') ? (opt.split('=')[0] as string) : opt;
    if (opt === '-c' || name === '--config-env')
      return refuse('setting git config on the command line is not allowed');
    if (GIT_FLAGS.includes(opt)) j += 1;
    else if (GIT_OPTS_WITH_VALUE.includes(opt)) j += 2;
    else if (name !== opt && GIT_OPTS_WITH_VALUE.includes(name)) j += 1;
    else return refuse(`git option "${name}" is not allowed`);
  }
  const sub = args[j];
  const rest = args.slice(j + 1);
  if (sub === undefined) return {};
  if (!GIT_SUBCOMMANDS.has(sub)) return refuse(`git subcommand "${sub}" is not allowed`);
  if (sub === 'push' || sub === 'send-pack') return { category: 'push' };
  if ((sub === 'subtree' || sub === 'lfs') && rest.includes('push')) return { category: 'push' };
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
  return {};
}
