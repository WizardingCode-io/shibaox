import { basename } from 'node:path';

export type ApprovalCategory = 'push' | 'deploy';
export type ToolCategory = ApprovalCategory | 'other';
export type BashAnalysis =
  | { ok: true; program: string; category: ToolCategory }
  | { ok: false; reason: string };

export const COMPOUND_REASON = 'compound commands are not allowed; run one command per call';

/** Deploy-capable programs and the verbs that make an invocation a deploy. */
export const DEPLOY_VERBS: Record<string, string[]> = {
  vercel: ['deploy', 'publish'],
  fly: ['deploy', 'publish'],
  flyctl: ['deploy', 'publish'],
  netlify: ['deploy', 'publish'],
  heroku: ['deploy', 'publish'],
  railway: ['deploy', 'publish'],
  wrangler: ['deploy', 'publish'],
  kubectl: ['apply', 'rollout', 'delete'],
  terraform: ['apply', 'destroy'],
  helm: ['install', 'upgrade', 'uninstall', 'rollback'],
};
/** Programs that never get a blanket allow rule: every call goes through `canUseTool`. */
export const GATED_PROGRAMS = ['git', ...Object.keys(DEPLOY_VERBS)];

// Command separators, pipes, substitutions and backgrounding (`&` but not `2>&1` / `&>`).
const COMPOUND = /;|&&|\||`|\$\(|[<>]\(|\n|\r|(?<![<>])&(?!>)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTS_WITH_VALUE = [
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
  '--config-env',
];
const HELP = ['--help', '-h', '--version', '-v'];

interface Token {
  text: string;
  /** Contains `$` outside single quotes (the shell would expand it). */
  expands: boolean;
}

/** Splits a simple command the way a POSIX shell would (quotes and backslashes). */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let cur: Token | undefined;
  let quote: "'" | '"' | undefined;
  const push = (ch: string, expandable: boolean) => {
    cur ??= { text: '', expands: false };
    cur.text += ch;
    if (ch === '$' && expandable) cur.expands = true;
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
    } else push(ch, true);
  }
  if (quote) return undefined;
  if (cur) tokens.push(cur);
  return tokens;
}

function analyseGit(args: Token[], assignments: string[]): BashAnalysis {
  if (assignments.some((a) => /^GIT_CONFIG/i.test(a) || /alias\./i.test(a)))
    return { ok: false, reason: 'configuring git through the environment is not allowed' };
  let j = 0;
  while (j < args.length && args[j]?.text.startsWith('-')) {
    const opt = args[j]?.text ?? '';
    const value = GIT_OPTS_WITH_VALUE.includes(opt) ? args[j + 1]?.text : opt.split('=')[1];
    if ((opt === '-c' || opt.startsWith('--config-env')) && /^alias\./i.test(value ?? ''))
      return { ok: false, reason: 'defining git aliases is not allowed' };
    j += GIT_OPTS_WITH_VALUE.includes(opt) ? 2 : 1;
  }
  const sub = args[j]?.text;
  const rest = args.slice(j + 1).map((t) => t.text);
  if (sub === 'push' || sub === 'send-pack') return { ok: true, program: 'git', category: 'push' };
  if ((sub === 'subtree' || sub === 'lfs') && rest.includes('push'))
    return { ok: true, program: 'git', category: 'push' };
  if (sub === 'config' && rest.some((a) => /^alias\./i.test(a)))
    return { ok: false, reason: 'defining git aliases is not allowed' };
  return { ok: true, program: 'git', category: 'other' };
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
  const gated = GATED_PROGRAMS.includes(program);
  if (gated && (head.expands || args.some((t) => t.expands)))
    return { ok: false, reason: `shell expansion is not allowed in ${program} commands` };
  if (program === 'git') return analyseGit(args, assignments);
  const verbs = DEPLOY_VERBS[program];
  if (verbs) {
    const words = args.map((t) => t.text);
    const positional = words.filter((w) => !w.startsWith('-'));
    const deploys =
      positional.some((w) => verbs.includes(w)) ||
      // `vercel` / `vercel --prod` deploy the current directory.
      (program === 'vercel' && positional.length === 0 && !words.some((w) => HELP.includes(w)));
    return { ok: true, program, category: deploys ? 'deploy' : 'other' };
  }
  return { ok: true, program, category: 'other' };
}
