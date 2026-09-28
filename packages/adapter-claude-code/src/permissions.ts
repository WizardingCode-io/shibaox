import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { type ApprovalHandler, argvHash, hostAllowed } from '@wizardingcode/shibaox-core';
import type { Role } from '@wizardingcode/shibaox-schemas';
import { type ApprovalCategory, analyseBashCommand, type ToolCategory } from './bash-command.js';
import { FILE_TOOLS } from './tools-map.js';

export const APPROVAL_PENDING = 'approval pending: the run is waiting for the inbox';

/** Classifies a tool request; `forbidden` means the command is refused whatever the role. */
export function classifyToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): ToolCategory | 'forbidden' {
  if (toolName !== 'Bash') return 'other';
  const a = analyseBashCommand(String(input.command ?? ''));
  return a.ok ? a.category : 'forbidden';
}

/** The real path of `p`: the realpath of its nearest existing ancestor plus the rest. */
function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  try {
    head = realpathSync(head);
  } catch {
    // keep the resolved path
  }
  return join(head, ...tail);
}

const expandHome = (p: string) =>
  p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;

/** Whether `target` (relative to `cwd`, `~` expanded) resolves inside `cwd`. */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  const root = realish(cwd);
  const p = realish(resolve(root, expandHome(target)));
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

const escapes = (pattern: string) =>
  isAbsolute(expandHome(pattern)) || pattern.split(/[\\/]/).includes('..');

/**
 * Why a file tool call is refused, or `undefined` when its target (`file_path`, `notebook_path`
 * or `path`, the workspace when absent) is inside the workspace. Glob/Grep patterns may not be
 * absolute or contain `..`, and writes may not touch `.git`.
 */
export function fileToolViolation(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const raw = input.file_path ?? input.notebook_path ?? input.path;
  const target = typeof raw === 'string' && raw !== '' ? raw : '.';
  if (/^~[^/]/.test(target)) return `path "${target}" is outside the workspace`;
  if (!isInsideWorkspace(cwd, target)) return `path "${target}" is outside the workspace`;
  for (const key of ['pattern', 'glob'] as const) {
    const v = input[key];
    if (toolName !== 'Grep' || key === 'glob')
      if (typeof v === 'string' && escapes(v)) return `${key} "${v}" is outside the workspace`;
  }
  if (
    FILE_TOOLS.write?.includes(toolName) &&
    target.split(/[\\/]/).some((seg) => seg.toLowerCase() === '.git')
  )
    return 'writing inside .git is not allowed';
  return undefined;
}

export interface CanUseToolArgs {
  role: Role;
  /** The task's working directory; file tools are confined to it. */
  cwd: string;
  approvals: ApprovalHandler;
  runId: string;
  nodeId: string;
  log: (line: string) => void;
  /** argvHash → approved, for commands already answered on this node (no second question). */
  approvedCommands?: Record<string, boolean>;
  /** Called when nobody answered in time (the task is then interrupted). */
  onDeferred?: (category: ApprovalCategory, approvalId: string) => void;
}

/**
 * The permission decision for every request not settled by the allow/deny rules. File tools are
 * allowed for the role's `read`/`write` inside `cwd` only; other non-Bash tools and programs
 * outside `role.tools` are denied; push/deploy need `approval_required` and a human
 * yes; any other single command of a listed program is allowed.
 */
export function buildCanUseTool(args: CanUseToolArgs): CanUseTool {
  const deny = (toolName: string, input: unknown, message: string): PermissionResult => {
    args.log(`[claude-code] denied ${toolName} ${JSON.stringify(input).slice(0, 200)}: ${message}`);
    return { behavior: 'deny', message };
  };
  const notAllowed = (name: string) => `tool "${name}" is not allowed for role ${args.role.role}`;
  return async (toolName, input, options): Promise<PermissionResult> => {
    const fileGroup = Object.entries(FILE_TOOLS).find(([, tools]) => tools.includes(toolName));
    if (fileGroup) {
      if (!args.role.tools.includes(fileGroup[0]))
        return deny(toolName, input, notAllowed(toolName));
      const violation = fileToolViolation(toolName, input, args.cwd);
      if (violation) return deny(toolName, input, violation);
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName === 'WebFetch' || toolName === 'WebSearch') {
      const network = args.role.permissions.network;
      if (network.length === 0) return deny(toolName, input, notAllowed(toolName));
      if (toolName === 'WebSearch') return { behavior: 'allow', updatedInput: input };
      let host: string;
      try {
        host = new URL(String(input.url ?? '')).hostname;
      } catch {
        return deny(toolName, input, `invalid url "${String(input.url ?? '')}"`);
      }
      if (!hostAllowed(host, network))
        return deny(
          toolName,
          input,
          `host "${host}" is not allowed (network: ${network.join(', ')})`,
        );
      return { behavior: 'allow', updatedInput: input };
    }
    if (toolName !== 'Bash') return deny(toolName, input, notAllowed(toolName));
    const command = String(input.command ?? '');
    const a = analyseBashCommand(command);
    if (!a.ok) return deny(toolName, input, a.reason);
    if (!args.role.tools.includes(a.program)) return deny(toolName, input, notAllowed(a.program));
    if (a.category === 'other') return { behavior: 'allow', updatedInput: input };
    const category = a.category;
    if (!args.role.permissions.approval_required.includes(category))
      return deny(toolName, input, `${category} requires approval_required in the role`);
    const hash = argvHash(a.argv);
    const earlier = args.approvedCommands?.[hash];
    if (earlier === true) return { behavior: 'allow', updatedInput: input };
    if (earlier === false)
      return deny(toolName, input, `${category} was already denied by the human`);
    const answer = await args.approvals.request(
      {
        runId: args.runId,
        nodeId: args.nodeId,
        role: args.role.role,
        tool: 'Bash',
        program: a.program,
        category,
        command,
        argv: a.argv,
      },
      { signal: options?.signal },
    );
    if ('deferred' in answer) {
      args.onDeferred?.(category, answer.approvalId);
      return { behavior: 'deny', message: APPROVAL_PENDING, interrupt: true };
    }
    if (answer.approved) return { behavior: 'allow', updatedInput: input };
    return deny(
      toolName,
      input,
      `human rejected ${category}${answer.note ? `: ${answer.note}` : ''}`,
    );
  };
}
