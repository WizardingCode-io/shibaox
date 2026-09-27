import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { mapRoleTools } from '../src/index.js';

describe('mapRoleTools', () => {
  it('maps role.tools to allow rules, never for file tools, git or deploy programs, and always denies dangerous commands', () => {
    const r = mapRoleTools(
      RoleSchema.parse({
        role: 'backend',
        tools: ['read', 'write', 'git', 'node', 'pnpm', 'jq', 'kubectl', 'vercel', 'terraform'],
      }),
    );
    // file tools are decided per path by canUseTool
    expect(r.allowedTools).toEqual(['Bash(node *)', 'Bash(jq *)']);
    expect(r.disallowedTools).toEqual([
      'Bash(rm -rf *)',
      'Bash(git push *)',
      'Bash(git push)',
      'WebFetch',
      'WebSearch',
    ]);
    expect(r).not.toHaveProperty('askTools');
  });
  it('lets push reach the approval callback when the role requires approval for it', () => {
    const r = mapRoleTools(
      RoleSchema.parse({
        role: 'backend',
        tools: ['git'],
        permissions: { approval_required: ['push'] },
      }),
    );
    expect(r.disallowedTools).not.toContain('Bash(git push *)');
    expect(r.allowedTools).toEqual([]);
  });
  it('a network allowlist lifts the web tools', () => {
    const r = mapRoleTools(
      RoleSchema.parse({ role: 'assistant', tools: ['read'], permissions: { network: ['*'] } }),
    );
    // WebFetch never gets an allow rule: a bare rule would skip canUseTool's host check
    expect(r.allowedTools).toEqual(['WebSearch']);
    expect(r.disallowedTools).toEqual(['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git push)']);
    const restricted = mapRoleTools(
      RoleSchema.parse({ role: 'a', tools: ['read'], permissions: { network: ['github.com'] } }),
    );
    expect(restricted.allowedTools).not.toContain('WebFetch');
    expect(restricted.disallowedTools).not.toContain('WebFetch');
  });
  it('an empty tools list allows only nothing beyond reading', () => {
    expect(mapRoleTools(RoleSchema.parse({ role: 'analyst' })).allowedTools).toEqual([]);
  });
});
