import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  type ApprovalHandler,
  argvHash,
  hostAllowed,
  isProtectedPath,
  workspaceLocalBin,
} from '@wizardingcode/shibaox-core';
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
  /** Globs (relative to cwd) write tools may not touch without a `protected` approval. */
  protectedPaths?: readonly string[];
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
  const protectedGlobsOf = () => [
    ...new Set([...args.role.permissions.protected, ...(args.protectedPaths ?? [])]),
  ];
  return async (toolName, input, options): Promise<PermissionResult> => {
    const fileGroup = Object.entries(FILE_TOOLS).find(([, tools]) => tools.includes(toolName));
    if (fileGroup) {
      if (!args.role.tools.includes(fileGroup[0]))
        return deny(toolName, input, notAllowed(toolName));
      const violation = fileToolViolation(toolName, input, args.cwd);
      if (violation) return deny(toolName, input, violation);
      if (fileGroup[0] === 'write') {
        const raw = input.file_path ?? input.notebook_path ?? input.path;
        const target = resolve(args.cwd, String(raw ?? ''));
        const rel = relative(args.cwd, target);
        if (isProtectedPath(args.cwd, target, protectedGlobsOf()))
          return ask(
            toolName,
            input,
            'protected',
            {
              tool: 'file',
              program: 'write',
              command: `write ${rel}`,
              argv: ['write', rel],
            },
            options?.signal,
          );
      }
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
    const a = analyseBashCommand(command, {
      network: args.role.permissions.network,
      localBin: workspaceLocalBin(args.cwd),
    });
    if (!a.ok) return deny(toolName, input, a.reason);
    if (!args.role.tools.includes(a.program)) return deny(toolName, input, notAllowed(a.program));
    if (a.category === 'other') return { behavior: 'allow', updatedInput: input };
    return ask(
      toolName,
      input,
      a.category,
      { tool: 'Bash', program: a.program, command, argv: a.argv },
      options?.signal,
    );
  };
  /** The human's answer for a categorised command or file write, remembered per node. */
  async function ask(
    toolName: string,
    input: Record<string, unknown>,
    category: ApprovalCategory,
    what: { tool: 'Bash' | 'file'; program: string; command: string; argv: string[] },
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    if (!args.role.permissions.approval_required.includes(category))
      return deny(
        toolName,
        input,
        what.tool === 'file'
          ? `${what.argv[1]} is protected: ${category} requires approval_required: [${category}] in the role`
          : `${category} requires approval_required: [${category}] in the role`,
      );
    const hash = argvHash(what.argv);
    const earlier = args.approvedCommands?.[hash];
    if (earlier === true) return { behavior: 'allow', updatedInput: input };
    if (earlier === false)
      return deny(toolName, input, `${category} was already denied by the human`);
    const answer = await args.approvals.request(
      { runId: args.runId, nodeId: args.nodeId, role: args.role.role, category, ...what },
      { signal },
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
  }
}
