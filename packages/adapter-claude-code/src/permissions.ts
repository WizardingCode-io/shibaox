import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { HumanHandler } from '@shibaox/core';
import type { Role } from '@shibaox/schemas';
import { type ApprovalCategory, analyseBashCommand, type ToolCategory } from './bash-command.js';

export const APPROVAL_PENDING = 'approval pending: run is waiting for a human';

/** Classifies a tool request; `forbidden` means the command is refused whatever the role. */
export function classifyToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): ToolCategory | 'forbidden' {
  if (toolName !== 'Bash') return 'other';
  const a = analyseBashCommand(String(input.command ?? ''));
  return a.ok ? a.category : 'forbidden';
}

export interface CanUseToolArgs {
  role: Role;
  human: HumanHandler;
  runId: string;
  nodeId: string;
  log: (line: string) => void;
  /** Called when the human defers an approval (the task is then interrupted). */
  onDeferred?: (category: ApprovalCategory) => void;
}

/**
 * The permission decision for every request not settled by the allow/deny rules. Non-Bash tools
 * and programs outside `role.tools` are denied; push/deploy need `approval_required` and a human
 * yes; any other single command of a listed program is allowed.
 */
export function buildCanUseTool(args: CanUseToolArgs): CanUseTool {
  const deny = (toolName: string, input: unknown, message: string): PermissionResult => {
    args.log(`[claude-code] denied ${toolName} ${JSON.stringify(input).slice(0, 200)}: ${message}`);
    return { behavior: 'deny', message };
  };
  const notAllowed = (name: string) => `tool "${name}" is not allowed for role ${args.role.role}`;
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName !== 'Bash') return deny(toolName, input, notAllowed(toolName));
    const command = String(input.command ?? '');
    const a = analyseBashCommand(command);
    if (!a.ok) return deny(toolName, input, a.reason);
    if (!args.role.tools.includes(a.program)) return deny(toolName, input, notAllowed(a.program));
    if (a.category === 'other') return { behavior: 'allow', updatedInput: input };
    const category = a.category;
    if (!args.role.permissions.approval_required.includes(category))
      return deny(toolName, input, `${category} requires approval_required in the role`);
    const answer = await args.human.ask({
      runId: args.runId,
      nodeId: args.nodeId,
      action: `approve-${category}`,
      prompt: `${toolName}: ${command}`,
    });
    if ('deferred' in answer) {
      args.onDeferred?.(category);
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
