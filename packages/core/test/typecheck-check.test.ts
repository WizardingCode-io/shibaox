import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckResultSchema,
  CheckSchema,
  CodeNodeSchema,
  GateSchema,
  loadOrg,
} from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import {
  AutoApproveHuman,
  codeCheckRunner,
  detectTypecheckCommand,
  MemoryEventStore,
  MockAdapter,
  RunEngine,
  ScriptedDecider,
  typecheckCheckRunner,
} from '../src/index.js';

function dir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'tc-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(d, rel, '..'), { recursive: true });
    writeFileSync(join(d, rel), content);
  }
  return d;
}
const ctx = (workspace: string) => ({ workspace, env: {} });

describe('the typecheck check', () => {
  it('is a check type resolved at run time from shibaox.yaml or the project, like tests and lint', async () => {
    const check = CheckSchema.parse({ name: 'typecheck', type: 'typecheck' });
    expect(check.type).toBe('typecheck');
    expect(
      CheckResultSchema.parse({
        name: 't',
        type: 'typecheck',
        passed: true,
        skipped: true,
        evidence: '',
      }).type,
    ).toBe('typecheck');
    const failing = await typecheckCheckRunner(
      check,
      ctx(dir({ 'shibaox.yaml': 'typecheck: "exit 3"\n' })),
    );
    expect(failing).toMatchObject({ passed: false, skipped: false });
    expect(failing.evidence).toContain('exit 3');
    const passing = await typecheckCheckRunner(
      check,
      ctx(dir({ 'shibaox.yaml': 'typecheck: "true"\n' })),
    );
    expect(passing).toMatchObject({ passed: true, skipped: false });
    const none = await typecheckCheckRunner(check, ctx(dir({})));
    expect(none).toMatchObject({ passed: true, skipped: true });
    expect(none.evidence).toMatch(/no type checker/);
    const missing = await typecheckCheckRunner(
      check,
      ctx(dir({ 'shibaox.yaml': 'typecheck: "definitely-missing-tool-xyz ."\n' })),
    );
    expect(missing).toMatchObject({ passed: true, skipped: true });
    expect(missing.evidence).toMatch(/not available/);
  });
  it('a code check with skip_if_missing passes with a note when the tool is not installed', async () => {
    const check = CheckSchema.parse({
      name: 'x',
      type: 'code',
      command: 'definitely-missing-tool-xyz',
      skip_if_missing: true,
    });
    expect(await codeCheckRunner(check, ctx(dir({})))).toMatchObject({
      passed: true,
      skipped: true,
    });
    const strict = CheckSchema.parse({
      name: 'x',
      type: 'code',
      command: 'definitely-missing-tool-xyz',
    });
    expect(await codeCheckRunner(strict, ctx(dir({})))).toMatchObject({ passed: false });
  });
});

describe('detectTypecheckCommand: the package manager and the project scripts', () => {
  it('prefers a typecheck script, then the runner of the lockfile, uv for uv projects, go build for Go', () => {
    expect(
      detectTypecheckCommand(
        dir({ 'package.json': '{"scripts":{"typecheck":"tsc -b"}}', 'pnpm-lock.yaml': '' }),
      ),
    ).toBe('pnpm run typecheck');
    expect(
      detectTypecheckCommand(dir({ 'package.json': '{"scripts":{"check-types":"tsc"}}' })),
    ).toBe('npm run check-types');
    expect(
      detectTypecheckCommand(dir({ 'package.json': '{}', 'tsconfig.json': '{}', 'yarn.lock': '' })),
    ).toBe('yarn tsc --noEmit');
    expect(
      detectTypecheckCommand(dir({ 'package.json': '{}', 'tsconfig.json': '{}', 'bun.lock': '' })),
    ).toBe('bunx tsc --noEmit');
    expect(detectTypecheckCommand(dir({ 'pyproject.toml': '[tool.mypy]\n', 'uv.lock': '' }))).toBe(
      'uv run mypy .',
    );
    expect(detectTypecheckCommand(dir({ 'pyrightconfig.json': '{}', 'uv.lock': '' }))).toBe(
      'uv run pyright',
    );
    expect(detectTypecheckCommand(dir({ 'setup.cfg': '[mypy]\n' }))).toBe('mypy .');
    expect(detectTypecheckCommand(dir({ '.mypy.ini': '' }))).toBe('mypy .');
    expect(detectTypecheckCommand(dir({ 'go.mod': 'module x' }))).toBe('go build ./...');
  });
});

describe('a code node with ok_exit_codes', () => {
  it('completes on a listed exit code instead of failing the run', async () => {
    expect(CodeNodeSchema.parse({ type: 'code', command: 'x' }).ok_exit_codes).toEqual([0]);
    const org = dir({
      'org.yaml': 'organization: wc\nteams: [eng]\n',
      'teams/eng.yaml': 'team: eng\nlead: tl\nroles: [tl]\ngates: []\nworkflows: [w]\n',
      'roles/tl.yaml': 'role: tl\n',
      'workflows/w.yaml':
        'workflow: w\nteam: eng\nstart: audit\nnodes:\n  audit: { type: code, command: "echo found; echo oops >&2; exit 1", ok_exit_codes: [0, 1] }\n',
    });
    const engine = new RunEngine({
      store: new MemoryEventStore(),
      org: loadOrg(org),
      adapters: { mock: new MockAdapter(() => ({ output: {}, summary: '' })) },
      decider: new ScriptedDecider({}),
      human: new AutoApproveHuman(),
    });
    const st = await engine.start({ workflow: 'w', input: {}, workspace: process.cwd() });
    expect(st.status).toBe('completed');
    // the next task reads both streams: an audit tool explains itself on stderr
    expect(st.nodes.audit?.output).toMatchObject({
      exitCode: 1,
      stdout: 'found\n',
      stderr: 'oops\n',
    });
    expect(GateSchema).toBeDefined();
  });
});
