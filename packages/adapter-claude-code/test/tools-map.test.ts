import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { mapRoleTools } from '../src/index.js';

describe('mapRoleTools', () => {
  it('maps role.tools to Claude Code allow rules and always denies dangerous commands', () => {
    const r = mapRoleTools(
      RoleSchema.parse({ role: 'backend', tools: ['read', 'write', 'git', 'node', 'pnpm', 'jq'] }),
    );
    expect(r.allowedTools).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'Bash(git *)',
      'Bash(node *)',
      'Bash(pnpm *)',
      'Bash(jq *)',
    ]);
    expect(r.disallowedTools).toEqual([
      'Bash(rm -rf *)',
      'Bash(git push *)',
      'Bash(git push)',
      'WebFetch',
      'WebSearch',
    ]);
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
    expect(r.allowedTools).not.toContain('Bash(git push *)');
  });
  it('an empty tools list allows only nothing beyond reading', () => {
    expect(mapRoleTools(RoleSchema.parse({ role: 'analyst' })).allowedTools).toEqual([]);
  });
  it('forces approval-gated commands through the callback with ask rules, even when a broader allow rule matches', () => {
    const r = mapRoleTools(
      RoleSchema.parse({
        role: 'ops',
        tools: ['git', 'kubectl'],
        permissions: { approval_required: ['push', 'deploy'] },
      }),
    );
    expect(r.allowedTools).toEqual(['Bash(git *)', 'Bash(kubectl *)']);
    expect(r.askTools).toEqual(
      expect.arrayContaining(['Bash(git push *)', 'Bash(git push)', 'Bash(kubectl apply *)']),
    );
    expect(mapRoleTools(RoleSchema.parse({ role: 'backend', tools: ['git'] })).askTools).toEqual(
      [],
    );
  });
});
