import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { HumanHandler } from '@shibaox/core';
import type { Role } from '@shibaox/schemas';

export type ToolCategory = 'push' | 'deploy' | 'other';

const DEPLOY = [
  /^(vercel|fly|flyctl|netlify|heroku|railway|wrangler)\b.*\b(deploy|publish)\b/,
  /^deploy\b/,
  /^kubectl\s+(apply|rollout|delete)\b/,
  /^terraform\s+apply\b/,
  /^helm\s+(install|upgrade)\b/,
];

export const APPROVAL_PENDING = 'approval pending: run is waiting for a human';

/** Classifies a tool request into the categories a role can gate behind human approval. */
export function classifyToolRequest(
  toolName: string,
  input: Record<string, unknown>,
): ToolCategory {
  if (toolName !== 'Bash') return 'other';
  const command = String(input.command ?? '').trim();
  if (/^git\s+push\b/.test(command)) return 'push';
  if (DEPLOY.some((re) => re.test(command))) return 'deploy';
  return 'other';
}

export interface CanUseToolArgs {
  role: Role;
  human: HumanHandler;
  runId: string;
  nodeId: string;
  log: (line: string) => void;
  /** Called when the human defers an approval (the task is then interrupted). */
  onDeferred?: (category: Exclude<ToolCategory, 'other'>) => void;
}

/**
 * Permission callback for requests not settled by the allow/deny rules. Only categories the role
 * lists in `approval_required` go to the human; everything else is denied — never allowed implicitly.
 */
export function buildCanUseTool(args: CanUseToolArgs): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const category = classifyToolRequest(toolName, input);
    if (category !== 'other' && args.role.permissions.approval_required.includes(category)) {
      const prompt = `${toolName}: ${String(input.command ?? JSON.stringify(input))}`;
      const answer = await args.human.ask({
        runId: args.runId,
        nodeId: args.nodeId,
        action: `approve-${category}`,
        prompt,
      });
      if ('deferred' in answer) {
        args.onDeferred?.(category);
        return { behavior: 'deny', message: APPROVAL_PENDING, interrupt: true };
      }
      if (answer.approved) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'deny',
        message: `human rejected ${category}${answer.note ? `: ${answer.note}` : ''}`,
      };
    }
    args.log(`[claude-code] denied ${toolName} ${JSON.stringify(input).slice(0, 200)}`);
    return {
      behavior: 'deny',
      message: `tool "${toolName}" is not allowed for role ${args.role.role}`,
    };
  };
}
