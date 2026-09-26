import { AutoApproveHuman, DeferHuman, type HumanRequest } from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { buildCanUseTool, classifyToolRequest } from '../src/index.js';

const role = RoleSchema.parse({
  role: 'backend',
  tools: ['git'],
  permissions: { approval_required: ['push'] },
});
const base = { role, runId: 'r', nodeId: 'implement', log: () => {} };
const opts = { signal: new AbortController().signal };

describe('classifyToolRequest', () => {
  it('recognises push and deploy commands', () => {
    expect(classifyToolRequest('Bash', { command: 'git push origin main' })).toBe('push');
    expect(classifyToolRequest('Bash', { command: 'vercel deploy --prod' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'kubectl apply -f x.yaml' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'ls' })).toBe('other');
    expect(classifyToolRequest('Edit', { file_path: 'a' })).toBe('other');
  });
});

describe('buildCanUseTool', () => {
  it('asks the human for approval_required categories and allows on yes', async () => {
    const asked: HumanRequest[] = [];
    const human = {
      ask: async (req: HumanRequest) => {
        asked.push(req);
        return { approved: true };
      },
    };
    const can = buildCanUseTool({ ...base, human });
    const r = await can('Bash', { command: 'git push origin main' }, opts);
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    expect(asked[0]).toMatchObject({ action: 'approve-push', nodeId: 'implement' });
  });
  it('denies with interrupt when the human defers', async () => {
    const can = buildCanUseTool({ ...base, human: new DeferHuman() });
    const r = await can('Bash', { command: 'git push' }, opts);
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
    expect((r as { message: string }).message).toContain('waiting for a human');
  });
  it('denies anything else that reaches the callback, even with an auto-approving human', async () => {
    const can = buildCanUseTool({ ...base, human: new AutoApproveHuman() });
    const r = await can('Bash', { command: 'curl http://x' }, opts);
    expect(r).toMatchObject({ behavior: 'deny' });
    expect((r as { message: string }).message).toContain('not allowed for role backend');
  });
  it('denies push when the role does not list it in approval_required', async () => {
    const can = buildCanUseTool({
      ...base,
      role: RoleSchema.parse({ role: 'analyst' }),
      human: new AutoApproveHuman(),
    });
    expect(await can('Bash', { command: 'git push' }, opts)).toMatchObject({ behavior: 'deny' });
  });
});
