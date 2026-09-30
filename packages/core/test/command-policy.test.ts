import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { classifyArgv, isProtected, protectedGlobs } from '../src/index.js';

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
