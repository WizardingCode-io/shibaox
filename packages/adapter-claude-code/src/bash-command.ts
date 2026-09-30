import { basename } from 'node:path';
import {
  type ApprovalCategory,
  analyseGitArgs,
  type ClassifyContext,
  classifyArgv,
  POLICY_PROGRAMS,
} from '@wizardingcode/shibaox-core';

export type { ApprovalCategory };
export type ToolCategory = ApprovalCategory | 'other';
export type BashAnalysis =
  | { ok: true; program: string; category: ToolCategory; argv: string[] }
  | { ok: false; reason: string };

export const COMPOUND_REASON = 'compound commands are not allowed; run one command per call';

/** Programs that never get a blanket allow rule: every call goes through `canUseTool`. */
/** Programs that never get a blanket allow rule: every call goes through `canUseTool` and the policy. */
export const GATED_PROGRAMS: readonly string[] = POLICY_PROGRAMS;

// Command separators, pipes, substitutions and backgrounding (`&` but not `2>&1` / `&>`).
const COMPOUND = /;|&&|\||`|\$\(|[<>]\(|\n|\r|(?<![<>])&(?!>)/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

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
  const argv = [...assignments, 'git', ...args.map((t) => t.text)];
  const v = analyseGitArgs(
    args.map((t) => t.text),
    assignments,
  );
  if (v.refused) return { ok: false, reason: v.refused };
  return { ok: true, program: 'git', category: v.category ?? 'other', argv };
}

/**
 * Parses one Bash command: rejects compound commands, finds the program (after `VAR=val`
 * prefixes and a leading `env`), and classifies git pushes and deploy-program invocations.
 */
export function analyseBashCommand(command: string, ctx: ClassifyContext = {}): BashAnalysis {
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
  // the assignments travel in argv so an approval never covers the same command under another environment
  const argv = [...assignments, head.text, ...args.map((t) => t.text)];
  const gated = GATED_PROGRAMS.includes(program);
  if (gated && head.text !== program)
    return { ok: false, reason: `run ${program} by name, not by path (${head.text})` };
  if (gated && (head.expands || args.some((t) => t.expands)))
    return { ok: false, reason: `shell expansion is not allowed in ${program} commands` };
  if (program === 'git') return analyseGit(args, assignments);
  const cls = classifyArgv([head.text, ...args.map((t) => t.text)], { ...ctx, assignments });
  if (cls.refused) return { ok: false, reason: cls.refused };
  return { ok: true, program, category: cls.category ?? 'other', argv };
}
