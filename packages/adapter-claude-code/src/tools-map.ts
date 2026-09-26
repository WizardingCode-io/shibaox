import type { Role } from '@shibaox/schemas';
import { GATED_PROGRAMS } from './bash-command.js';

const MAP: Record<string, string[]> = { read: ['Read', 'Glob', 'Grep'], write: ['Edit', 'Write'] };

/** Rules denied to every role; `git push` is lifted only so it can reach the approval callback. */
export const ALWAYS_DENY = [
  'Bash(rm -rf *)',
  'Bash(git push *)',
  'Bash(git push)',
  'WebFetch',
  'WebSearch',
];

/**
 * Maps a role's `tools` to Claude Code allow/deny rules. git and deploy-capable programs never get
 * an allow rule: prefix rules cannot see through `git -C x push` and similar, so every call to
 * them is decided by `canUseTool`.
 */
export function mapRoleTools(role: Role): { allowedTools: string[]; disallowedTools: string[] } {
  const allowedTools = role.tools.flatMap((t) =>
    GATED_PROGRAMS.includes(t) ? [] : (MAP[t] ?? [`Bash(${t} *)`]),
  );
  const needsPushApproval = role.permissions.approval_required.includes('push');
  const disallowedTools = ALWAYS_DENY.filter(
    (d) => !(needsPushApproval && d.startsWith('Bash(git push')),
  );
  return { allowedTools, disallowedTools };
}
