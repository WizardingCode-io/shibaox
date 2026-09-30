import { join } from 'node:path';
import {
  type ApprovalAnswer,
  type ApprovalRequest,
  AutoApproveApprovals,
  DenyApprovals,
} from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { buildCanUseTool, classifyToolRequest } from '../src/index.js';

const role = RoleSchema.parse({
  role: 'backend',
  tools: ['git'],
  permissions: { approval_required: ['push'] },
});
const base = { role, cwd: process.cwd(), runId: 'r', nodeId: 'implement', log: () => {} };
const opts = { signal: new AbortController().signal, toolUseID: 't' };
const bash = (command: string) => ['Bash', { command }, opts] as const;
const message = (r: unknown) => (r as { message?: string }).message ?? '';
const recorder = (answer: ApprovalAnswer) => {
  const asked: ApprovalRequest[] = [];
  const request = async (req: ApprovalRequest) => {
    asked.push(req);
    return answer;
  };
  return { asked, approvals: { request } };
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
      'FOO=1 git push',
      'env git push',
      'env -u X FOO=1 git push',
      'git --no-pager --git-dir=.git push',
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
  it('refuses unquoted brace, glob and tilde expansion in gated commands', () => {
    for (const command of [
      'git {push,origin}',
      'git pu?h',
      'git [p]ush',
      'git pu*',
      'git ~/x',
      'kubectl {apply,-f,x}',
      'helm {upgrade,x,y}',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('forbidden');
    expect(classifyToolRequest('Bash', { command: 'git commit -m "fix {a,b}"' })).toBe('other');
    expect(classifyToolRequest('Bash', { command: "git log --format='%H [x]'" })).toBe('other');
  });
  it('gates every mutating deploy verb', () => {
    for (const command of [
      'railway up',
      'vercel ./dir',
      'vercel --prod',
      'vercel --yes',
      'fly launch',
      'flyctl deploy',
      'kubectl patch deploy x',
      'kubectl -n prod scale deploy x --replicas=0',
      'kubectl set image deploy/x a=b',
      'terraform import a b',
      'terraform state rm x',
      'heroku container:release web',
      'heroku releases:rollback',
      'wrangler deploy',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('deploy');
    for (const command of [
      'vercel env ls',
      'vercel ls',
      'vercel logs x',
      'vercel --help',
      'kubectl get pods',
      'terraform plan',
      'fly status',
      'railway logs',
    ])
      expect(classifyToolRequest('Bash', { command }), command).toBe('other');
  });
});

describe('git classifier fails closed', () => {
  const cls = (command: string) => classifyToolRequest('Bash', { command });
  it('refuses unknown git global options (they may take a value that hides the subcommand)', () => {
    for (const command of [
      'git --attr-source HEAD push origin main',
      'git --attr-source=HEAD push',
      'git --super-prefix x/ push',
      'git --exec-path=/tmp/x status',
      'git --frobnicate push',
      'git -X push',
    ])
      expect(cls(command), command).toBe('forbidden');
    for (const command of [
      'git --no-pager log',
      'git -C sub status',
      'git --git-dir=.git --work-tree=. status',
      'git --no-optional-locks status',
      'git -P diff',
    ])
      expect(cls(command), command).toBe('other');
  });
  it('refuses -c, --config-env and git config writes', () => {
    for (const command of [
      'git -c core.pager=x log',
      'git -c include.path=/tmp/evil status',
      'git --config-env=core.sshCommand=X fetch',
      'git --config-env core.pager=X log',
      'git config include.path /tmp/evil',
      'git config core.hooksPath /tmp/hooks',
      'git config core.pager "sh -c x"',
      'git config core.sshCommand x',
      'git config user.name bob',
      'git config --global user.name bob',
      'git config --add remote.origin.pushurl x',
      'git config --unset core.pager',
      'git config --edit',
      'git config -e',
      'git config set core.pager x',
      'git config --get core.pager --add x y',
    ])
      expect(cls(command), command).toBe('forbidden');
    for (const command of [
      'git config --get user.name',
      'git config --list',
      'git config -l',
      'git config --get-regexp ^remote',
      'git config get user.name',
      'git config list',
    ])
      expect(cls(command), command).toBe('other');
  });
  it('refuses gated programs invoked by path', () => {
    for (const command of [
      './git push',
      '/usr/bin/git push',
      '/usr/bin/git status',
      'bin/vercel deploy',
      './npm publish',
      'env /usr/bin/git push',
    ])
      expect(cls(command), command).toBe('forbidden');
  });
  it('refuses git subcommands that run other commands and unknown subcommands (aliases)', () => {
    for (const command of [
      'git rebase --exec "git push" HEAD~1',
      'git rebase -x x HEAD~1',
      'git submodule foreach git push',
      'git bisect run ./x',
      'git filter-branch --tree-filter x',
      'git difftool --extcmd x',
      'git grep -O"sh -c id" foo',
      'git grep -Ovim foo',
      'git grep --open-files-in-pager=x foo',
      'git p origin main',
      'GIT_SSH_COMMAND=x git fetch',
      'GIT_EXEC_PATH=/tmp git status',
    ])
      expect(cls(command), command).toBe('forbidden');
    for (const command of [
      'git status',
      'git rebase -i HEAD~1',
      'git submodule update --init',
      'git commit -m "x"',
      'GIT_AUTHOR_NAME=bot git commit -m x',
    ])
      expect(cls(command), command).toBe('other');
  });
});

describe('package publish verbs are gated as deploy', () => {
  const cls = (command: string) => classifyToolRequest('Bash', { command });
  it('gates npm/pnpm/yarn publish-like verbs and docker push', () => {
    for (const command of [
      'npm publish',
      'npm publish --access public',
      'npm unpublish x@1',
      'npm dist-tag add x@1 latest',
      'npm deprecate x "old"',
      'pnpm publish',
      'pnpm -r publish',
      'pnpm dist-tag add x@1 latest',
      'yarn publish',
      'yarn npm publish',
      'docker push img:tag',
      'docker buildx build --push -t x .',
      'npm dist-tags add x@1 latest',
    ])
      expect(cls(command), command).toBe('deploy');
    for (const command of [
      'npm test',
      'npm install',
      'pnpm test',
      'pnpm build',
      'yarn install',
      'docker build -t img .',
    ])
      expect(cls(command), command).toBe('other');
  });
});

describe('buildCanUseTool', () => {
  it('asks the human for approval_required categories and allows on yes', async () => {
    const { asked, approvals } = recorder({ approved: true });
    const can = buildCanUseTool({ ...base, approvals });
    const r = await can(...bash('git push origin main'));
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    expect(asked[0]).toMatchObject({ category: 'push', nodeId: 'implement', program: 'git' });
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
    const { asked, approvals } = recorder({ approved: true });
    const ops = RoleSchema.parse({
      role: 'ops',
      tools: ['kubectl'],
      permissions: { approval_required: ['deploy'] },
    });
    const can = buildCanUseTool({ ...base, role: ops, approvals });
    expect(await can(...bash('kubectl -n prod apply -f x'))).toMatchObject({ behavior: 'allow' });
    expect(asked[0]).toMatchObject({ category: 'deploy', program: 'kubectl' });
    expect(await can(...bash('kubectl get pods'))).toMatchObject({ behavior: 'allow' });
    expect(asked).toHaveLength(1);
  });
  it('denies with interrupt when nobody answers in time', async () => {
    const can = buildCanUseTool({
      ...base,
      ...recorder({ deferred: true, approvalId: 'a1' }),
    });
    const r = await can(...bash('git push'));
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(message(r)).toContain('waiting for the inbox');
  });
  it('denies programs that are not in role.tools, even with an auto-approving human', async () => {
    const can = buildCanUseTool({ ...base, approvals: new AutoApproveApprovals() });
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
    const { asked, approvals } = recorder({ approved: true });
    const r = await buildCanUseTool({ ...base, role: noGit, approvals })(...bash('git push'));
    expect(message(r)).toContain('not allowed for role analyst');
    expect(asked).toHaveLength(0);
  });
  it('denies push/deploy when the role has the program but does not gate the category', async () => {
    const r = await buildCanUseTool({
      ...base,
      role: RoleSchema.parse({ role: 'backend', tools: ['git'] }),
      approvals: new AutoApproveApprovals(),
    })(...bash('git -C . push'));
    expect(r).toMatchObject({ behavior: 'deny' });
    expect(message(r)).toBe('push requires approval_required: [push] in the role');
  });
  it('allows ordinary commands of listed programs', async () => {
    const can = buildCanUseTool({
      ...base,
      role: RoleSchema.parse({ role: 'backend', tools: ['git', 'vercel'] }),
      approvals: new DenyApprovals(),
    });
    expect(await can(...bash('git status'))).toMatchObject({ behavior: 'allow' });
    expect(await can(...bash('vercel env ls'))).toMatchObject({ behavior: 'allow' });
  });
  it('denies compound commands and git alias definitions', async () => {
    const can = buildCanUseTool({ ...base, approvals: new AutoApproveApprovals() });
    for (const command of ['git status && git push', 'git status; git push', 'git $(echo push)']) {
      const r = await can(...bash(command));
      expect(r, command).toMatchObject({ behavior: 'deny' });
      expect(message(r)).toBe('compound commands are not allowed; run one command per call');
    }
    expect(await can(...bash("git config alias.p 'push'"))).toMatchObject({ behavior: 'deny' });
  });
});

describe('web tools', () => {
  const webRole = (network: string[]) =>
    RoleSchema.parse({ role: 'assistant', tools: ['read'], permissions: { network } });
  it('WebFetch is allowed for hosts in the allowlist only; WebSearch needs any allowlist', async () => {
    const can = (network: string[]) =>
      buildCanUseTool({ ...base, role: webRole(network), approvals: new DenyApprovals() });
    const fetchGh = ['WebFetch', { url: 'https://api.github.com/repos' }, opts] as const;
    expect((await can(['github.com'])(...fetchGh)).behavior).toBe('allow');
    expect((await can(['*'])(...fetchGh)).behavior).toBe('allow');
    const denied = await can(['example.com'])(...fetchGh);
    expect(denied.behavior).toBe('deny');
    expect(message(denied)).toContain('api.github.com');
    expect((await can([])(...fetchGh)).behavior).toBe('deny');
    expect((await can(['github.com'])('WebSearch', { query: 'x' }, opts)).behavior).toBe('allow');
    expect((await can([])('WebSearch', { query: 'x' }, opts)).behavior).toBe('deny');
    expect((await can(['*'])('WebFetch', { url: 'not a url' }, opts)).behavior).toBe('deny');
  });
});

describe('semantic approvals (claude-code)', () => {
  const ctx = { signal: new AbortController().signal, suggestions: [] };
  const build = (
    role: Record<string, unknown>,
    o: { protected?: string[]; ask?: (req: ApprovalRequest) => void } = {},
  ) =>
    buildCanUseTool({
      role: RoleSchema.parse({
        role: 'backend',
        tools: ['read', 'write', 'node', 'curl', 'npx', 'wget'],
        ...role,
      }),
      cwd: process.cwd(),
      approvals: {
        async request(req) {
          o.ask?.(req);
          return { approved: true };
        },
      },
      runId: 'r',
      nodeId: 'n',
      log: () => {},
      protectedPaths: o.protected ?? [],
    });
  it('execute and network categories go through approval_required', async () => {
    const deny = build({});
    expect(await deny('Bash', { command: 'node -e 1' }, ctx)).toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/execute requires approval_required/),
    });
    expect(await deny('Bash', { command: 'curl https://evil.example/' }, ctx)).toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/network requires approval_required/),
    });
    const asked: ApprovalRequest[] = [];
    const allow = build(
      { permissions: { network: ['api.github.com'], approval_required: ['execute', 'network'] } },
      { ask: (r) => asked.push(r) },
    );
    expect(await allow('Bash', { command: 'curl https://api.github.com/x' }, ctx)).toMatchObject({
      behavior: 'allow',
    });
    expect(await allow('Bash', { command: 'npx cowsay hi' }, ctx)).toMatchObject({
      behavior: 'allow',
    });
    expect(asked.map((r) => r.category)).toEqual(['execute']);
    expect(await allow('Bash', { command: 'wget https://evil.example/' }, ctx)).toMatchObject({
      behavior: 'allow',
    });
    expect(asked.map((r) => r.category)).toEqual(['execute', 'network']);
  });
  it('write tools on a protected path are refused, or asked as a file approval', async () => {
    const deny = build({ permissions: { protected: ['infra/**'] } });
    const target = join(process.cwd(), 'infra', 'prod.tf');
    expect(
      await deny('Edit', { file_path: target, old_string: 'a', new_string: 'b' }, ctx),
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/infra\/prod\.tf.*protected/),
    });
    expect(await deny('Read', { file_path: target }, ctx)).toMatchObject({ behavior: 'allow' });
    const asked: ApprovalRequest[] = [];
    const ask = build(
      { permissions: { approval_required: ['protected'] } },
      { protected: ['infra/**'], ask: (r) => asked.push(r) },
    );
    expect(await ask('Write', { file_path: target, content: 'x' }, ctx)).toMatchObject({
      behavior: 'allow',
    });
    expect(asked[0]).toMatchObject({
      category: 'protected',
      tool: 'file',
      command: 'write infra/prod.tf',
      argv: ['write', 'infra/prod.tf'],
    });
  });
});
