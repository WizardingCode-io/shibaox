import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { SubmitRequest } from '@shibaox/daemon';
import fuzzysort from 'fuzzysort';

export type Adapter = 'mock' | 'claude-code' | 'direct';
export const ADAPTERS: Adapter[] = ['mock', 'claude-code', 'direct'];
const WORKSPACES = ['inplace', 'worktree'] as const;

export interface PromptContext {
  org: string;
  project: string;
  workflow?: string;
  adapter: Adapter;
  budgetUsd?: number;
  workspace?: 'inplace' | 'worktree';
}

export const COMMANDS = [
  'workflow',
  'project',
  'org',
  'adapter',
  'budget',
  'workspace',
  'runs',
  'help',
] as const;
export type CommandName = (typeof COMMANDS)[number];
export interface PromptCommand {
  command: CommandName;
  arg: string;
}

export function parsePromptCommand(text: string): PromptCommand | undefined {
  const m = /^\/(\S+)\s*(.*)$/s.exec(text.trim());
  if (!m) return undefined;
  const command = COMMANDS.find((c) => c === m[1]);
  if (!command) return undefined;
  return { command, arg: (m[2] ?? '').trim() };
}

function rank(query: string, targets: readonly string[]): string[] {
  if (!query) return [...targets];
  return fuzzysort.go(query, targets, { limit: 6 }).map((r) => r.target);
}

/** Suggestions for the text typed so far: command names, then the values of the current command. */
export function completeCommand(
  text: string,
  o: { workflows: string[] },
): { label: string; insert: string }[] {
  if (!text.startsWith('/')) return [];
  const m = /^\/(\S*)(\s+(.*))?$/s.exec(text);
  if (!m) return [];
  const name = m[1] ?? '';
  if (m[2] === undefined) {
    return rank(name, COMMANDS).map((c) => ({ label: `/${c}`, insert: `/${c} ` }));
  }
  const arg = (m[3] ?? '').trim();
  const values: readonly string[] =
    name === 'workflow'
      ? o.workflows
      : name === 'adapter'
        ? ADAPTERS
        : name === 'workspace'
          ? WORKSPACES
          : [];
  return rank(arg, values).map((v) => ({ label: v, insert: `/${name} ${v}` }));
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Applies a `/command arg` to the prompt context, or explains why it cannot. */
export function applyPromptCommand(
  ctx: PromptContext,
  cmd: PromptCommand,
  o: { cwd: string },
): PromptContext | { error: string } {
  const dir = (p: string) => {
    const e = expandHome(p);
    return isAbsolute(e) ? e : resolve(o.cwd, e);
  };
  switch (cmd.command) {
    case 'workflow':
      if (!cmd.arg) return { error: 'Workflow name is required' };
      return { ...ctx, workflow: cmd.arg };
    case 'project':
      if (!cmd.arg) return { error: 'Project directory is required' };
      return { ...ctx, project: dir(cmd.arg) };
    case 'org':
      if (!cmd.arg) return { error: 'Org directory is required' };
      return { ...ctx, org: dir(cmd.arg) };
    case 'adapter': {
      const a = ADAPTERS.find((x) => x === cmd.arg);
      if (!a) return { error: `Adapter must be one of ${ADAPTERS.join(', ')}` };
      return { ...ctx, adapter: a };
    }
    case 'budget': {
      const n = Number(cmd.arg);
      if (!cmd.arg || !Number.isFinite(n) || n <= 0) return { error: 'Budget must be a number' };
      return { ...ctx, budgetUsd: n };
    }
    case 'workspace': {
      const w = WORKSPACES.find((x) => x === cmd.arg);
      if (!w) return { error: `Workspace must be one of ${WORKSPACES.join(', ')}` };
      return { ...ctx, workspace: w };
    }
    default:
      return ctx;
  }
}

export function toSubmitRequest(ctx: PromptContext, input: string): SubmitRequest {
  return {
    orgRoot: ctx.org,
    project: ctx.project,
    workflow: ctx.workflow ?? '',
    input,
    adapter: ctx.adapter,
    workspace: ctx.workspace,
    budgetUsd: ctx.budgetUsd,
  };
}
