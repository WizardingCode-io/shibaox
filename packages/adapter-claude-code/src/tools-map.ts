import type { Role } from '@wizardingcode/shibaox-schemas';
import { GATED_PROGRAMS } from './bash-command.js';

/**
 * Claude Code file tools per role tool name. They never get an allow rule (a bare `Edit` rule
 * would allow any path): `canUseTool` allows them only for paths inside the workspace.
 */
export const FILE_TOOLS: Record<string, string[]> = {
  read: ['Read', 'Glob', 'Grep'],
  write: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
};

/** The web tools: denied unless the role has a `permissions.network` allowlist. */
export const WEB_TOOLS = ['WebFetch', 'WebSearch'];

/**
 * Rules denied to every role; `git push` is lifted only so it can reach the approval callback,
 * the web tools only for roles with a network allowlist. `WebFetch` never gets an allow rule
 * (an allow rule skips `canUseTool`, which is where the host is checked); `WebSearch` does.
 */
export const ALWAYS_DENY = ['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git push)', ...WEB_TOOLS];

/**
 * Maps a role's `tools` to Claude Code allow/deny rules. File tools, git and deploy-capable
 * programs never get an allow rule: prefix rules cannot see through `git -C x push` and similar, so every call to
 * them is decided by `canUseTool`.
 */
export function mapRoleTools(role: Role): { allowedTools: string[]; disallowedTools: string[] } {
  const allowedTools = role.tools.flatMap((t) =>
    GATED_PROGRAMS.includes(t) || FILE_TOOLS[t] ? [] : [`Bash(${t} *)`],
  );
  const needsPushApproval = role.permissions.approval_required.includes('push');
  const web = role.permissions.network.length > 0;
  const disallowedTools = ALWAYS_DENY.filter(
    (d) => !(needsPushApproval && d.startsWith('Bash(git push')) && !(web && WEB_TOOLS.includes(d)),
  );
  return { allowedTools: [...allowedTools, ...(web ? ['WebSearch'] : [])], disallowedTools };
}
