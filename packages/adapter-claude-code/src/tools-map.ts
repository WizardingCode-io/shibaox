import type { Role } from '@shibaox/schemas';

const MAP: Record<string, string[]> = { read: ['Read', 'Glob', 'Grep'], write: ['Edit', 'Write'] };

/** Rules denied to every role; `git push` is lifted only so it can reach the approval callback. */
export const ALWAYS_DENY = [
  'Bash(rm -rf *)',
  'Bash(git push *)',
  'Bash(git push)',
  'WebFetch',
  'WebSearch',
];

const both = (prefix: string) => [`Bash(${prefix} *)`, `Bash(${prefix})`];
const DEPLOY_CLIS = ['vercel', 'fly', 'flyctl', 'netlify', 'heroku', 'railway', 'wrangler'];

/**
 * "Ask" rules per approval category. Claude Code evaluates deny > ask > allow, so these make a
 * gated command reach `canUseTool` even when a broader allow rule (e.g. `Bash(git *)`) matches it.
 */
export const APPROVAL_ASK_RULES: Record<string, string[]> = {
  push: both('git push'),
  deploy: [
    ...both('deploy'),
    ...DEPLOY_CLIS.flatMap((cli) => [...both(`${cli} deploy`), ...both(`${cli} publish`)]),
    ...['apply', 'rollout', 'delete'].map((sub) => `Bash(kubectl ${sub} *)`),
    ...both('terraform apply'),
    ...['install', 'upgrade'].map((sub) => `Bash(helm ${sub} *)`),
  ],
};

/** Maps a role's `tools` to Claude Code allow/ask/deny permission rules. */
export function mapRoleTools(role: Role): {
  allowedTools: string[];
  disallowedTools: string[];
  askTools: string[];
} {
  const allowedTools = role.tools.flatMap((t) => MAP[t] ?? [`Bash(${t} *)`]);
  const gated = role.permissions.approval_required;
  const disallowedTools = ALWAYS_DENY.filter(
    (d) => !(gated.includes('push') && d.startsWith('Bash(git push')),
  );
  const askTools = gated.flatMap((c) => APPROVAL_ASK_RULES[c] ?? []);
  return { allowedTools, disallowedTools, askTools };
}
