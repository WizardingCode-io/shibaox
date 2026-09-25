import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrg, OrgLoadError } from '../src/index.js';

function scaffold(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const good = {
  'org.yaml': 'organization: wc\nteams: [eng]\n',
  'teams/eng.yaml':
    'team: eng\nlead: tl\nroles: [tl, backend]\ngates: [tests]\nworkflows: [hello]\n',
  'roles/tl.yaml': 'role: tl\n',
  'roles/backend.yaml': 'role: backend\n',
  'gates/tests.yaml': 'gate: tests\nchecks:\n  - { name: t, type: mock, passes: true }\n',
  'workflows/hello.yaml':
    'workflow: hello\nteam: eng\nstart: a\nnodes:\n  a: { type: task, role: backend, next: g }\n  g: { type: gate, gates: [tests], on_pass: h, on_fail: a }\n  h: { type: human, action: ok }\n',
};

describe('loadOrg', () => {
  it('loads a valid org directory', () => {
    const org = loadOrg(scaffold(good));
    expect(org.org.organization).toBe('wc');
    expect(Object.keys(org.roles).sort()).toEqual(['backend', 'tl']);
    expect(org.workflows.hello?.start).toBe('a');
    expect(org.models.tiers).toEqual({});
  });

  it('reports the file and node for a broken reference', () => {
    const dir = scaffold({
      ...good,
      'workflows/hello.yaml': good['workflows/hello.yaml'].replace('next: g', 'next: zzz'),
    });
    expect(() => loadOrg(dir)).toThrowError(OrgLoadError);
    try {
      loadOrg(dir);
    } catch (e) {
      const err = e as OrgLoadError;
      expect(err.file).toContain('workflows/hello.yaml');
      expect(err.message).toContain('zzz');
    }
  });

  it('rejects a workflow task using a role the org does not define', () => {
    const dir = scaffold({
      ...good,
      'workflows/hello.yaml': good['workflows/hello.yaml'].replace('role: backend', 'role: ghost'),
    });
    expect(() => loadOrg(dir)).toThrowError(/role "ghost"/);
  });

  it('rejects a team listing an unknown gate', () => {
    const dir = scaffold({
      ...good,
      'teams/eng.yaml': good['teams/eng.yaml'].replace('gates: [tests]', 'gates: [nope]'),
    });
    expect(() => loadOrg(dir)).toThrowError(/gate "nope"/);
  });

  it('reports the actual source file, not a synthesized path, for a team cross-validation error', () => {
    const filesWithoutTeam = Object.fromEntries(
      Object.entries(good).filter(([rel]) => rel !== 'teams/eng.yaml'),
    );
    const dir = scaffold({
      ...filesWithoutTeam,
      'teams/eng-team.yml': good['teams/eng.yaml'].replace('gates: [tests]', 'gates: [nope]'),
    });
    expect(() => loadOrg(dir)).toThrowError(OrgLoadError);
    try {
      loadOrg(dir);
    } catch (e) {
      const err = e as OrgLoadError;
      expect(err.file).toBe('teams/eng-team.yml');
    }
  });

  it('rejects duplicate ids across files in the same directory', () => {
    const dir = scaffold({
      ...good,
      'roles/a.yaml': 'role: dup\n',
      'roles/b.yaml': 'role: dup\n',
    });
    expect(() => loadOrg(dir)).toThrowError(OrgLoadError);
    try {
      loadOrg(dir);
    } catch (e) {
      const err = e as OrgLoadError;
      expect(err.message).toContain('duplicate');
      expect(err.message).toContain('dup');
      expect(err.message).toContain('roles/a.yaml');
    }
  });
});
