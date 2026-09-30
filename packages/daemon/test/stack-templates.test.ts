import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectTeamGates } from '@wizardingcode/shibaox-core';
import { loadOrg, loadProjectFile, RoutineFileSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { STACKS, scaffoldOrg } from '../src/templates.js';

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');
const scan = (dir: string) => loadOrg(join(dir, 'org')).workflows['security-scan'];

describe('scaffoldOrg with a stack', () => {
  it('node: protected-only shibaox.yaml with detection as comments, typecheck in every qa gate, stack review, security-scan, frontend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-'));
    writeFileSync(
      join(dir, 'package.json'),
      '{"scripts":{"test":"vitest run","lint":"biome check ."}}',
    );
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const created = scaffoldOrg(dir, { stack: 'node' });
    expect(created).toContain('shibaox.yaml');
    // nothing detection can guess is frozen into the file; what was detected is left as a comment
    const project = loadProjectFile(dir);
    expect(project?.protected).toEqual([
      'shibaox.yaml',
      '.github/workflows/**',
      '.env',
      '.env.local',
      '.env.*.local',
    ]);
    expect(project?.tests).toBeUndefined();
    expect(project?.setup).toBeUndefined();
    expect(read(dir, 'shibaox.yaml')).toContain('detected: tests: pnpm test');
    expect(read(dir, 'shibaox.yaml')).toContain('detected: typecheck: pnpm exec tsc --noEmit');
    const org = loadOrg(join(dir, 'org'));
    // the gate resolves the checker at run time (shibaox.yaml typecheck, else detection)
    expect(org.gates.typecheck?.checks[0]).toMatchObject({ type: 'typecheck' });
    expect(org.gates.review?.checks[0]).toMatchObject({ type: 'review' });
    expect(JSON.stringify(org.gates.review?.checks[0])).toMatch(/any/);
    expect(org.teams.engineering?.gates).toEqual(['tests', 'typecheck']);
    // the generic workflows carry the team gates in their own qa gate, so nothing is injected
    for (const w of ['hello-feature', 'land-feature', 'fix-issue']) {
      const wf = org.workflows[w];
      expect(wf?.nodes.qa, w).toMatchObject({ type: 'gate', gates: ['tests', 'typecheck'] });
      expect(
        Object.keys(injectTeamGates(wf as never, org.teams.engineering as never).nodes),
        w,
      ).toEqual(Object.keys(wf?.nodes ?? {}));
    }
    expect(org.workflows['security-scan']?.team_gates).toBe(false);
    expect(org.teams.engineering?.roles).toContain('frontend');
    expect(org.teams.engineering?.workflows).toContain('security-scan');
    expect(org.roles.frontend?.tools).toEqual(expect.arrayContaining(['node', 'yarn', 'bun']));
    // pnpm lockfile → pnpm audit; findings exit 1 and still reach the triage
    expect(scan(dir)?.nodes.audit).toMatchObject({
      type: 'code',
      skip_if_missing: true,
      ok_exit_codes: [0, 1],
    });
    expect(JSON.stringify(scan(dir)?.nodes.audit)).toContain('pnpm audit');
    expect(scan(dir)?.nodes.triage).toMatchObject({ type: 'task' });
    const routine = RoutineFileSchema.parse(parse(read(dir, 'org/routines/security-scan.yaml')));
    expect(routine.workflow).toBe('security-scan');
    expect(routine.on).toMatchObject({ type: 'cron' });
    // the generic scaffold is still there
    expect(org.workflows.chat).toBeDefined();
    expect(existsSync(join(dir, 'vault', '90-system'))).toBe(true);
  });
  it('every stack scaffolds a loadable org with the typecheck gate wired; the generic init has no shibaox.yaml', () => {
    for (const stack of STACKS) {
      const dir = mkdtempSync(join(tmpdir(), `stack-${stack}-`));
      scaffoldOrg(dir, { stack });
      const org = loadOrg(join(dir, 'org'));
      expect(org.workflows['security-scan'], stack).toBeDefined();
      expect(org.gates.typecheck?.checks[0], stack).toMatchObject({ type: 'typecheck' });
      expect(org.teams.engineering?.gates, stack).toEqual(['tests', 'typecheck']);
      expect(loadProjectFile(dir)?.protected, stack).toContain('shibaox.yaml');
    }
    const plain = mkdtempSync(join(tmpdir(), 'stack-plain-'));
    scaffoldOrg(plain);
    expect(existsSync(join(plain, 'shibaox.yaml'))).toBe(false);
    expect(loadOrg(join(plain, 'org')).workflows['security-scan']).toBeUndefined();
  });
  it('audit commands follow the stack and its lockfile, with the exit codes that carry findings', () => {
    const withFiles = (stack: (typeof STACKS)[number], files: Record<string, string> = {}) => {
      const dir = mkdtempSync(join(tmpdir(), 'stack-'));
      for (const [rel, c] of Object.entries(files)) writeFileSync(join(dir, rel), c);
      scaffoldOrg(dir, { stack });
      return scan(dir)?.nodes.audit as { command: string; ok_exit_codes: number[] };
    };
    expect(withFiles('node')).toMatchObject({
      // npm audit needs a lockfile: without one it is created first (install scripts never run)
      command: 'npm install --package-lock-only --ignore-scripts && npm audit --audit-level=high',
      ok_exit_codes: [0, 1],
    });
    expect(withFiles('node', { 'package-lock.json': '{}' }).command).toBe(
      'npm audit --audit-level=high',
    );
    expect(withFiles('node', { 'yarn.lock': '' }).command).toContain('yarn audit');
    expect(withFiles('node', { 'yarn.lock': '', '.yarnrc.yml': '' }).command).toContain(
      'yarn npm audit',
    );
    expect(withFiles('node', { 'bun.lock': '' }).command).toBe('bun audit');
    expect(withFiles('python')).toMatchObject({ command: 'pip-audit .', ok_exit_codes: [0, 1] });
    expect(withFiles('python', { 'requirements.txt': '' }).command).toBe(
      'pip-audit -r requirements.txt',
    );
    expect(withFiles('python', { 'uv.lock': '' }).command).toContain('uv run --with pip-audit');
    expect(withFiles('php-laravel')).toMatchObject({
      command: 'composer audit',
      ok_exit_codes: [0, 1, 2, 3],
    });
    expect(withFiles('go')).toMatchObject({ command: 'govulncheck ./...', ok_exit_codes: [0, 3] });
  });
});

describe('init --stack on an org that already exists', () => {
  it('adds the missing stack files and names the ones it kept, so the wiring is done by hand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stack-again-'));
    scaffoldOrg(dir);
    const kept: string[] = [];
    const created = scaffoldOrg(dir, { stack: 'go', onKept: (rel) => kept.push(rel) });
    expect(created).toEqual(
      expect.arrayContaining([
        'shibaox.yaml',
        'org/gates/typecheck.yaml',
        'org/workflows/security-scan.yaml',
      ]),
    );
    expect(kept).toEqual(
      expect.arrayContaining(['org/teams/engineering.yaml', 'org/gates/review.yaml']),
    );
  });
});
