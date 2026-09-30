import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg, loadProjectFile, RoutineFileSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STACKS, scaffoldOrg } from '../src/templates.js';

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

describe('scaffoldOrg with a stack', () => {
  it('node: shibaox.yaml, typecheck when tsconfig exists, stack review criteria, security-scan, frontend role', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"scripts":{"test":"vitest run","lint":"biome check ."}}',
    );
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const created = scaffoldOrg(dir, { stack: 'node' });
    expect(created).toContain('shibaox.yaml');
    const project = loadProjectFile(dir);
    expect(project).toMatchObject({
      setup: 'pnpm install --frozen-lockfile',
      tests: 'pnpm test',
      lint: 'pnpm run lint',
      typecheck: 'pnpm exec tsc --noEmit',
      protected: ['.github/workflows/**', '.env', '.env.*'],
    });
    const org = loadOrg(join(dir, 'org'));
    expect(org.gates.typecheck?.checks[0]).toMatchObject({
      type: 'code',
      command: 'pnpm exec tsc --noEmit',
    });
    expect(org.gates.review?.checks[0]).toMatchObject({ type: 'review' });
    expect(JSON.stringify(org.gates.review?.checks[0])).toMatch(/any/);
    expect(org.teams.engineering?.gates).toEqual(['tests', 'typecheck']);
    expect(org.teams.engineering?.roles).toContain('frontend');
    expect(org.teams.engineering?.workflows).toContain('security-scan');
    expect(org.roles.frontend?.tools).toContain('node');
    const scan = org.workflows['security-scan'];
    expect(scan?.nodes.audit).toMatchObject({ type: 'code', skip_if_missing: true });
    expect(JSON.stringify(scan?.nodes.audit)).toContain('npm audit');
    expect(scan?.nodes.triage).toMatchObject({ type: 'task' });
    const routine = RoutineFileSchema.parse(parse(read(dir, 'org/routines/security-scan.yaml')));
    expect(routine.workflow).toBe('security-scan');
    expect(routine.on).toMatchObject({ type: 'cron' });
    // the generic scaffold is still there
    expect(org.workflows['hello-feature']).toBeDefined();
    expect(existsSync(join(dir, 'vault', '90-system'))).toBe(true);
  });
  it('every stack scaffolds a loadable org; without a checker there is no typecheck gate; the generic init has no shibaox.yaml', () => {
    for (const stack of STACKS) {
      const dir = mkdtempSync(join(tmpdir(), `stack-${stack}-`));
      scaffoldOrg(dir, { stack });
      const org = loadOrg(join(dir, 'org'));
      expect(org.workflows['security-scan'], stack).toBeDefined();
      expect(org.gates.typecheck !== undefined, stack).toBe(stack === 'go');
      expect(org.teams.engineering?.gates, stack).toEqual(
        stack === 'go' ? ['tests', 'typecheck'] : ['tests'],
      );
      expect(loadProjectFile(dir)?.protected, stack).toContain('.env');
    }
    const plain = mkdtempSync(join(tmpdir(), 'stack-plain-'));
    scaffoldOrg(plain);
    expect(existsSync(join(plain, 'shibaox.yaml'))).toBe(false);
    expect(loadOrg(join(plain, 'org')).workflows['security-scan']).toBeUndefined();
  });
  it('audit commands per stack', () => {
    const cmd = (stack: (typeof STACKS)[number]) => {
      const dir = mkdtempSync(join(tmpdir(), 'stack-'));
      scaffoldOrg(dir, { stack });
      return String(
        loadOrg(join(dir, 'org')).workflows['security-scan']?.nodes.audit &&
          JSON.stringify(loadOrg(join(dir, 'org')).workflows['security-scan']?.nodes.audit),
      );
    };
    expect(cmd('node')).toContain('npm audit');
    expect(cmd('python')).toContain('pip-audit');
    expect(cmd('php-laravel')).toContain('composer audit');
    expect(cmd('go')).toContain('govulncheck');
  });
});
