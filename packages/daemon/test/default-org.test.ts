import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDefaultOrg } from '../src/default-org.js';
import { homePaths } from '../src/home.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const paths = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dorg-'));
  dirs.push(dir);
  return homePaths({ SHIBAOX_HOME: join(dir, '.shibaox') });
};

describe('ensureDefaultOrg', () => {
  it('creates the org and vault under the shibaox home, on the Claude subscription when claude is installed', () => {
    const p = paths();
    expect(p.org).toBe(join(p.root, 'org'));
    const r = ensureDefaultOrg(p, { env: {}, claude: true });
    expect(r).toEqual({ root: p.org, created: true });
    expect(existsSync(join(p.org, 'org.yaml'))).toBe(true);
    expect(existsSync(join(p.org, 'workflows', 'chat.yaml'))).toBe(true);
    expect(existsSync(join(p.root, 'vault', '10-projects'))).toBe(true);
    const models = readFileSync(join(p.org, 'models.yaml'), 'utf8');
    expect(models).toContain('strong: anthropic-subscription/claude-sonnet-5');
    expect(models).toContain('cheap: anthropic-subscription/claude-haiku-4-5');
    expect(readFileSync(join(p.org, 'org.yaml'), 'utf8')).toContain('adapter: claude-code');
  });
  it('prefers OpenRouter when there is a key and no claude, and leaves the template otherwise', () => {
    const a = paths();
    ensureDefaultOrg(a, { env: { OPENROUTER_API_KEY: 'sk-or-x' }, claude: false });
    const models = readFileSync(join(a.org, 'models.yaml'), 'utf8');
    expect(models).toContain('strong: openrouter/anthropic/claude-sonnet-4.5');
    expect(models).toContain('decision: openrouter/typesafe/jev-router');
    expect(readFileSync(join(a.org, 'org.yaml'), 'utf8')).toContain('adapter: direct');
    const b = paths();
    ensureDefaultOrg(b, { env: {}, claude: false });
    expect(readFileSync(join(b.org, 'models.yaml'), 'utf8')).toContain(
      'strong: anthropic/claude-sonnet-5',
    );
  });
  it('never touches an org that already exists', () => {
    const p = paths();
    ensureDefaultOrg(p, { env: {}, claude: false });
    writeFileSync(
      join(p.org, 'models.yaml'),
      'providers: {}\ntiers: { strong: mine/x }\nroles: {}\ngates: {}\n',
    );
    const r = ensureDefaultOrg(p, { env: {}, claude: true });
    expect(r.created).toBe(false);
    expect(readFileSync(join(p.org, 'models.yaml'), 'utf8')).toContain('mine/x');
  });
});

describe('the GitHub loop in the template', () => {
  it('ships a reviewer role, a ci gate and the fix-issue / review-pr workflows, all loadable', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { loadOrg } = await import('@wizardingcode/shibaox-schemas');
    const { scaffoldOrg } = await import('../src/templates.js');
    const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
    try {
      scaffoldOrg(dir);
      const org = loadOrg(join(dir, 'org'));
      expect(org.roles.reviewer).toMatchObject({ tools: expect.arrayContaining(['read', 'gh']) });
      expect(org.roles.reviewer?.tools).not.toContain('write');
      expect(org.gates.ci?.checks[0]).toMatchObject({ type: 'ci' });
      const fix = org.workflows['fix-issue'];
      expect(fix?.nodes.pr).toMatchObject({ type: 'git', action: 'pr' });
      expect(fix?.nodes.checks).toMatchObject({ type: 'gate', gates: ['ci'] });
      expect(fix?.nodes.land).toMatchObject({ type: 'git', action: 'merge_pr' });
      expect(Object.values(fix?.nodes ?? {}).some((n) => n.type === 'human')).toBe(true);
      const review = org.workflows['review-pr'];
      expect(review?.nodes.publish).toMatchObject({
        type: 'git',
        action: 'review',
        from: 'review',
      });
      expect(Object.values(review?.nodes ?? {}).some((n) => n.type === 'human')).toBe(true);
      expect(org.teams.engineering?.workflows).toEqual(
        expect.arrayContaining(['fix-issue', 'review-pr']),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
