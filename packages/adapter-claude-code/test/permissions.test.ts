import { AutoApproveHuman, DeferHuman, type HumanAnswer, type HumanRequest } from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { buildCanUseTool, classifyToolRequest } from '../src/index.js';

const role = RoleSchema.parse({
  role: 'backend',
  tools: ['git'],
  permissions: { approval_required: ['push'] },
});
const base = { role, runId: 'r', nodeId: 'implement', log: () => {} };
const opts = { signal: new AbortController().signal, toolUseID: 't' };
const bash = (command: string) => ['Bash', { command }, opts] as const;
const message = (r: unknown) => (r as { message?: string }).message ?? '';
const recorder = (answer: HumanAnswer) => {
  const asked: HumanRequest[] = [];
  const ask = async (req: HumanRequest) => {
    asked.push(req);
    return answer;
  };
  return { asked, human: { ask } };
};

describe('classifyToolRequest', () => {
  it('recognises push and deploy commands', () => {
    expect(classifyToolRequest('Bash', { command: 'git push origin main' })).toBe('push');
    expect(classifyToolRequest('Bash', { command: 'vercel deploy --prod' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'kubectl apply -f x.yaml' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'ls' })).toBe('other');
    expect(classifyToolRequest('Edit', { file_path: 'a' })).toBe('other');
  });
  it('sees push through git global options, env prefixes and quoting', () => {
    for (const command of [
      'git -C x push',
      'git -c a=b push origin main',
      'FOO=1 git push',
      'env git push',
      'env -u X FOO=1 git push',
      '/usr/bin/git --no-pager --git-dir=.git push',
      'git "pu"sh',
      'git send-pack origin',
      'git subtree push --prefix x origin main',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('push');
    expect(classifyToolRequest('Bash', { command: 'git -C push status' })).toBe('other');
  });
  it('classifies deploy verbs anywhere in a deploy-program invocation', () => {
    for (const command of [
      'kubectl -n prod apply -f x',
      'terraform -chdir=infra apply',
      'helm upgrade app ./chart',
      'wrangler pages deploy dist',
      'netlify deploy --prod',
      'vercel',
      'vercel --prod',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'vercel env ls' })).toBe('other');
    expect(classifyToolRequest('Bash', { command: 'kubectl get pods' })).toBe('other');
  });
  it('marks compound commands and git alias tricks as forbidden', () => {
    for (const command of [
      'git status && git push',
      'git status; git push',
      'git $(echo push)',
      'git `echo push`',
      'git status | cat',
      'git status\ngit push',
      "git config alias.p 'push'",
      'git -c alias.p=push p',
      'GIT_CONFIG_COUNT=1 git p',
      'X=push git $X',
      'env -S "git push"',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('forbidden');
  });
});

describe('buildCanUseTool', () => {
  it('asks the human for approval_required categories and allows on yes', async () => {
    const { asked, human } = recorder({ approved: true });
    const can = buildCanUseTool({ ...base, human });
    const r = await can(...bash('git push origin main'));
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    expect(asked[0]).toMatchObject({ action: 'approve-push', nodeId: 'implement' });
  });
  it('denies on rejection, with and without a note', async () => {
    const withNote = buildCanUseTool({
      ...base,
      ...recorder({ approved: false, note: 'not now' }),
    });
    const r1 = await withNote(...bash('git push'));
    expect(r1).toMatchObject({ behavior: 'deny' });
    expect(message(r1)).toBe('human rejected push: not now');
    const bare = buildCanUseTool({ ...base, ...recorder({ approved: false }) });
    expect(message(await bare(...bash('git push')))).toBe('human rejected push');
  });
  it('asks for deploy when the role gates it', async () => {
    const { asked, human } = recorder({ approved: true });
    const ops = RoleSchema.parse({
      role: 'ops',
      tools: ['kubectl'],
      permissions: { approval_required: ['deploy'] },
    });
    const can = buildCanUseTool({ ...base, role: ops, human });
    expect(await can(...bash('kubectl -n prod apply -f x'))).toMatchObject({ behavior: 'allow' });
    expect(asked[0]).toMatchObject({ action: 'approve-deploy' });
    expect(await can(...bash('kubectl get pods'))).toMatchObject({ behavior: 'allow' });
    expect(asked).toHaveLength(1);
  });
  it('denies with interrupt when the human defers', async () => {
    const can = buildCanUseTool({ ...base, human: new DeferHuman() });
    const r = await can(...bash('git push'));
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(message(r)).toContain('waiting for a human');
  });
  it('denies programs that are not in role.tools, even with an auto-approving human', async () => {
    const can = buildCanUseTool({ ...base, human: new AutoApproveHuman() });
    const r = await can(...bash('curl http://x'));
    expect(r).toMatchObject({ behavior: 'deny' });
    expect(message(r)).toBe('tool "curl" is not allowed for role backend');
    expect(message(await can('Edit', { file_path: 'a' }, opts))).toContain(
      'tool "Edit" is not allowed for role backend',
    );
  });
  it('denies push for a role that does not have git in its tools', async () => {
    const noGit = RoleSchema.parse({
      role: 'analyst',
      permissions: { approval_required: ['push'] },
    });
    const { asked, human } = recorder({ approved: true });
    const r = await buildCanUseTool({ ...base, role: noGit, human })(...bash('git push'));
    expect(message(r)).toContain('not allowed for role analyst');
    expect(asked).toHaveLength(0);
  });
  it('denies push/deploy when the role has the program but does not gate the category', async () => {
    const r = await buildCanUseTool({
      ...base,
      role: RoleSchema.parse({ role: 'backend', tools: ['git'] }),
      human: new AutoApproveHuman(),
    })(...bash('git -C . push'));
    expect(r).toMatchObject({ behavior: 'deny' });
    expect(message(r)).toBe('push requires approval_required in the role');
  });
  it('allows ordinary commands of listed programs', async () => {
    const can = buildCanUseTool({
      ...base,
      role: RoleSchema.parse({ role: 'backend', tools: ['git', 'vercel'] }),
      human: new DeferHuman(),
    });
    expect(await can(...bash('git status'))).toMatchObject({ behavior: 'allow' });
    expect(await can(...bash('vercel env ls'))).toMatchObject({ behavior: 'allow' });
  });
  it('denies compound commands and git alias definitions', async () => {
    const can = buildCanUseTool({ ...base, human: new AutoApproveHuman() });
    for (const command of ['git status && git push', 'git status; git push', 'git $(echo push)']) {
      const r = await can(...bash(command));
      expect(r, command).toMatchObject({ behavior: 'deny' });
      expect(message(r)).toBe('compound commands are not allowed; run one command per call');
    }
    expect(await can(...bash("git config alias.p 'push'"))).toMatchObject({ behavior: 'deny' });
  });
});
