import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ModelChoice, SubmitRequest } from '@shibaox/daemon';
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
  /** A model ref (`provider/model`) for every task; the adapter follows from it. */
  model?: string;
}

export const COMMANDS = [
  'model',
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

/** How each command takes its value: from a list, as free text, or none (it acts at once). */
export const COMMAND_KIND: Record<CommandName, 'choice' | 'text' | 'action'> = {
  model: 'choice',
  workflow: 'choice',
  adapter: 'choice',
  workspace: 'choice',
  project: 'text',
  org: 'text',
  budget: 'text',
  runs: 'action',
  help: 'action',
};

/** What to ask for when a free-text command is entered without its value. */
export const COMMAND_HINT: Record<CommandName, string> = {
  model: 'pick the provider/model for the run',
  workflow: 'pick a workflow of the org',
  adapter: 'pick an adapter: mock, claude-code or direct',
  workspace: 'pick inplace or worktree',
  project: 'type the project directory and press enter',
  org: 'type the org directory and press enter',
  budget: 'type the budget in USD and press enter',
  runs: 'open a run',
  help: 'show the keys',
};
export interface PromptCommand {
  command: string;
  arg: string;
}

/** A value a choice command offers, with what to say about it. */
export interface ValueChoice {
  value: string;
  hint?: string;
  /** Listed after the usable values whatever the match (a model whose key is missing). */
  disabled?: boolean;
}

/** A `/command` a prompt offers: its kind decides what enter does, `values` feed the list. */
export interface PromptCommandSpec {
  name: string;
  kind: 'choice' | 'text' | 'action';
  hint: string;
  values?: () => readonly (string | ValueChoice)[];
}

/** `/model` values: the daemon's models, configured ones first, the others say what they miss. */
export function modelValues(models: readonly ModelChoice[]): ValueChoice[] {
  return [...models]
    .sort((a, b) => Number(b.configured) - Number(a.configured))
    .map((m) => ({
      value: m.ref,
      hint: m.local
        ? m.available === false
          ? 'local (server not reachable)'
          : 'local'
        : m.configured
          ? (m.runtime ?? 'direct')
          : `needs ${m.missing?.join(', ') || 'configuration'}`,
      disabled: !m.configured || m.available === false,
    }));
}

/** The model spec of a `/model` command for both prompts. */
export function modelCommand(models: () => readonly ModelChoice[]): PromptCommandSpec {
  return {
    name: 'model',
    kind: 'choice',
    hint: COMMAND_HINT.model,
    values: () => modelValues(models()),
  };
}

/** The home prompt's commands (the run context), with the org's workflows and the models as values. */
export function homeCommands(
  workflows: readonly string[],
  models: readonly ModelChoice[] = [],
): PromptCommandSpec[] {
  return COMMANDS.map((name) =>
    name === 'model'
      ? modelCommand(() => models)
      : {
          name,
          kind: COMMAND_KIND[name],
          hint: COMMAND_HINT[name],
          values:
            name === 'workflow'
              ? () => workflows
              : name === 'adapter'
                ? () => ADAPTERS
                : name === 'workspace'
                  ? () => WORKSPACES
                  : undefined,
        },
  );
}

/** The adapter a chosen model runs through, from the daemon's list (`claude-code` for a subscription). */
export function adapterForModel(ref: string, models: readonly ModelChoice[]): Adapter | undefined {
  const m = models.find((x) => x.ref === ref);
  if (!m) return undefined;
  return m.runtime === 'claude-code' ? 'claude-code' : 'direct';
}

export function parsePromptCommand(
  text: string,
  commands: readonly PromptCommandSpec[],
): PromptCommand | undefined {
  const m = /^\/(\S+)\s*(.*)$/s.exec(text.trim());
  if (!m) return undefined;
  const command = commands.find((c) => c.name === m[1]);
  if (!command) return undefined;
  return { command: command.name, arg: (m[2] ?? '').trim() };
}

/** Rows the suggestion list shows at most. */
export const SUGGESTIONS = 10;

function rank(query: string, targets: readonly string[]): string[] {
  if (!query) return targets.slice(0, SUGGESTIONS);
  return fuzzysort.go(query, targets, { limit: SUGGESTIONS }).map((r) => r.target);
}

export interface Suggestion {
  label: string;
  insert: string;
  /** What the command does, shown beside it. */
  hint?: string;
}

/** Suggestions for the text typed so far: command names, then the values of the current command. */
export function completeCommand(
  text: string,
  o: { commands: readonly PromptCommandSpec[] },
): Suggestion[] {
  if (!text.startsWith('/')) return [];
  const m = /^\/(\S*)(\s+(.*))?$/s.exec(text);
  if (!m) return [];
  const name = m[1] ?? '';
  const byName = new Map(o.commands.map((c) => [c.name, c]));
  if (m[2] === undefined) {
    return rank(name, [...byName.keys()]).map((c) => ({
      label: `/${c}`,
      insert: `/${c} `,
      hint: byName.get(c)?.hint,
    }));
  }
  const arg = (m[3] ?? '').trim();
  const values = (byName.get(name)?.values?.() ?? []).map((v) =>
    typeof v === 'string' ? { value: v } : v,
  );
  const byValue = new Map(values.map((v) => [v.value, v]));
  const ranked = rank(
    arg,
    values.map((v) => v.value),
  );
  // usable values first, whatever the match score: enter must never pick one that cannot run
  const usable = ranked.filter((v) => !byValue.get(v)?.disabled);
  const rest = ranked.filter((v) => byValue.get(v)?.disabled);
  return [...usable, ...rest].map((v) => ({
    label: v,
    insert: `/${name} ${v}`,
    hint: byValue.get(v)?.hint,
  }));
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
  switch (cmd.command as CommandName) {
    case 'model': {
      if (!/^[a-z0-9][a-z0-9-]*\/\S+$/i.test(cmd.arg))
        return { error: 'Model must look like provider/model (see /model for the list)' };
      return { ...ctx, model: cmd.arg };
    }
    case 'workflow':
      if (!cmd.arg) return { error: 'Workflow name is required' };
      return { ...ctx, workflow: cmd.arg };
    case 'project': {
      if (!cmd.arg) return { error: 'Project directory is required' };
      const p = dir(cmd.arg);
      if (!existsSync(p)) return { error: `Project not found: ${p}` };
      return { ...ctx, project: p };
    }
    case 'org': {
      if (!cmd.arg) return { error: 'Org directory is required' };
      const p = dir(cmd.arg);
      if (!existsSync(p)) return { error: `Org not found: ${p}` };
      return { ...ctx, org: p };
    }
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
    ...(ctx.model ? { model: ctx.model } : {}),
  };
}
