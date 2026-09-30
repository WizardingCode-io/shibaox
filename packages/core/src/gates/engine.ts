import type { Check, CheckResult, Cost, Gate, GateReport } from '@wizardingcode/shibaox-schemas';
import { runCommand } from '../executors/code.js';
import type { RunState } from '../run/state.js';
import { ciCheckRunner } from './ci.js';
import { detectLintCommand, detectTestCommand, detectTypecheckCommand } from './detect.js';

export interface CheckContext {
  runId: string;
  nodeId: string;
  workspace: string;
  state: RunState;
  log: (line: string) => void;
  /** The run's abort signal; runners that call models should forward it. */
  signal?: AbortSignal;
  /** Diff of the run's workspace, when the engine was given a `diffProvider`. */
  diff?: () => Promise<string>;
  /** The environment of check commands (the daemon's, vault keys included). */
  env?: Record<string, string>;
}
export type CheckRunner = (check: Check, ctx: CheckContext) => Promise<CheckResult>;
export type CheckRunners = Partial<Record<Check['type'], CheckRunner>>;

const tail = (s: string, n = 2000) => (s.length > n ? `…${s.slice(-n)}` : s);

export const codeCheckRunner: CheckRunner = async (check, ctx) => {
  if (check.type !== 'code') throw new Error('codeCheckRunner got a non-code check');
  const r = await runCommand({
    command: check.command,
    cwd: ctx.workspace,
    timeoutMs: check.timeout_ms,
    env: ctx.env,
  });
  if (
    check.skip_if_missing &&
    (r.exitCode === 127 || (r.exitCode !== 0 && NOT_INSTALLED.test(r.stderr)))
  )
    return {
      name: check.name,
      type: 'code',
      passed: true,
      skipped: true,
      evidence: `not available here (\`${check.command}\`): ${r.stderr.trim().split('\n')[0] ?? ''}`,
    };
  const passed = r.exitCode === 0 && !r.timedOut;
  const evidence = r.timedOut
    ? `timed out after ${check.timeout_ms}ms\n${tail(r.stdout)}${tail(r.stderr)}`
    : `exit ${r.exitCode}\n${tail(r.stdout)}${tail(r.stderr)}`;
  return {
    name: check.name,
    type: 'code',
    passed,
    skipped: false,
    evidence,
    suggestion: passed ? undefined : `Fix so that \`${check.command}\` exits 0`,
  };
};

/** Runs the workspace's own test runner; a project without one passes with a note. */
export const testsCheckRunner: CheckRunner = async (check, ctx) => {
  if (check.type !== 'tests') throw new Error('testsCheckRunner got a non-tests check');
  const command = detectTestCommand(ctx.workspace);
  if (!command)
    return {
      name: check.name,
      type: 'tests',
      passed: true,
      skipped: true,
      evidence: `no test runner found in ${ctx.workspace} (package.json scripts.test, pyproject, go.mod, Cargo.toml, Makefile test, composer, Gemfile)`,
    };
  const r = await runCommand({
    command,
    cwd: ctx.workspace,
    timeoutMs: check.timeout_ms,
    env: ctx.env,
  });
  const passed = r.exitCode === 0 && !r.timedOut;
  const evidence = r.timedOut
    ? `${command}: timed out after ${check.timeout_ms}ms\n${tail(r.stdout)}${tail(r.stderr)}`
    : `${command}: exit ${r.exitCode}\n${tail(r.stdout)}${tail(r.stderr)}`;
  return {
    name: check.name,
    type: 'tests',
    passed,
    skipped: false,
    evidence,
    suggestion: passed ? undefined : `Fix so that \`${command}\` exits 0`,
  };
};

/** The tool itself is missing (not on PATH, not installed): the project is not at fault. */
const NOT_INSTALLED =
  /command not found|not found|No such file or directory|could not determine executable|canceled due to missing packages|not installed|ENOENT/i;

/** Runs the workspace's linter (detected, or `command`); no linter, or one that is not installed, passes with a note. */
export const lintCheckRunner: CheckRunner = async (check, ctx) => {
  if (check.type !== 'lint') throw new Error('lintCheckRunner got a non-lint check');
  const command = check.command ?? detectLintCommand(ctx.workspace);
  if (!command)
    return {
      name: check.name,
      type: 'lint',
      passed: true,
      skipped: true,
      evidence: `no linter found in ${ctx.workspace} (package.json scripts.lint, make lint, biome, eslint, ruff, phpstan, golangci-lint, go vet, clippy)`,
    };
  const r = await runCommand({
    command,
    cwd: ctx.workspace,
    timeoutMs: check.timeout_ms,
    env: ctx.env,
  });
  const missing = r.exitCode === 127 || (r.exitCode !== 0 && NOT_INSTALLED.test(r.stderr));
  if (missing)
    return {
      name: check.name,
      type: 'lint',
      passed: true,
      skipped: true,
      evidence: `linter not available here (\`${command}\`): ${r.stderr.trim().split('\n')[0] ?? ''}`,
    };
  const passed = r.exitCode === 0 && !r.timedOut;
  const evidence = r.timedOut
    ? `${command}: timed out after ${check.timeout_ms}ms\n${tail(r.stdout)}${tail(r.stderr)}`
    : `${command}: exit ${r.exitCode}\n${tail(r.stdout)}${tail(r.stderr)}`;
  return {
    name: check.name,
    type: 'lint',
    passed,
    skipped: false,
    evidence,
    suggestion: passed ? undefined : `Fix the reported problems so that \`${command}\` exits 0`,
  };
};

/** Runs the workspace's type checker (detected, or `command`); none, or one not installed, passes with a note. */
export const typecheckCheckRunner: CheckRunner = async (check, ctx) => {
  if (check.type !== 'typecheck') throw new Error('typecheckCheckRunner got a non-typecheck check');
  const command = check.command ?? detectTypecheckCommand(ctx.workspace);
  if (!command)
    return {
      name: check.name,
      type: 'typecheck',
      passed: true,
      skipped: true,
      evidence: `no type checker found in ${ctx.workspace} (shibaox.yaml typecheck, a typecheck script, tsconfig, mypy/pyright config, go.mod, phpstan)`,
    };
  const r = await runCommand({
    command,
    cwd: ctx.workspace,
    timeoutMs: check.timeout_ms,
    env: ctx.env,
  });
  const missing = r.exitCode === 127 || (r.exitCode !== 0 && NOT_INSTALLED.test(r.stderr));
  if (missing)
    return {
      name: check.name,
      type: 'typecheck',
      passed: true,
      skipped: true,
      evidence: `type checker not available here (\`${command}\`): ${r.stderr.trim().split('\n')[0] ?? ''}`,
    };
  const passed = r.exitCode === 0 && !r.timedOut;
  const evidence = r.timedOut
    ? `${command}: timed out after ${check.timeout_ms}ms\n${tail(r.stdout)}${tail(r.stderr)}`
    : `${command}: exit ${r.exitCode}\n${tail(r.stdout)}${tail(r.stderr)}`;
  return {
    name: check.name,
    type: 'typecheck',
    passed,
    skipped: false,
    evidence,
    suggestion: passed ? undefined : `Fix the reported type errors so that \`${command}\` exits 0`,
  };
};

export const mockCheckRunner: CheckRunner = async (check) => {
  if (check.type !== 'mock') throw new Error('mockCheckRunner got a non-mock check');
  return {
    name: check.name,
    type: 'mock',
    passed: check.passes,
    skipped: false,
    evidence: check.evidence,
  };
};

export function defaultCheckRunners(): CheckRunners {
  return {
    code: codeCheckRunner,
    tests: testsCheckRunner,
    lint: lintCheckRunner,
    typecheck: typecheckCheckRunner,
    ci: ciCheckRunner,
    mock: mockCheckRunner,
  };
}

export async function runGate(args: {
  gateIds: string[];
  gates: Record<string, Gate>;
  runners: CheckRunners;
  ctx: CheckContext;
}): Promise<GateReport> {
  const checks: CheckResult[] = [];
  let failed = false;
  for (const gateId of args.gateIds) {
    const gate = args.gates[gateId];
    if (!gate) throw new Error(`gate "${gateId}" is not defined`);
    for (const check of gate.checks) {
      if (failed) {
        checks.push({
          name: check.name,
          type: check.type,
          passed: false,
          skipped: true,
          evidence: 'skipped: an earlier check failed',
        });
        continue;
      }
      const runner = args.runners[check.type];
      let result: CheckResult;
      if (runner) {
        try {
          result = await runner(check, args.ctx);
        } catch (e) {
          result = {
            name: check.name,
            type: check.type,
            passed: false,
            skipped: false,
            evidence: `runner error: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      } else {
        result = {
          name: check.name,
          type: check.type,
          passed: false,
          skipped: false,
          evidence: `no runner registered for check type "${check.type}"`,
        };
      }
      args.ctx.log(`[gate ${gateId}] ${check.name}: ${result.passed ? 'pass' : 'FAIL'}`);
      checks.push(result);
      if (!result.passed) failed = true;
    }
  }
  return { gates: args.gateIds, passed: !failed, checks, cost: sumCosts(checks) };
}

function sumCosts(checks: readonly CheckResult[]): Cost | undefined {
  const costs = checks.flatMap((c) => (c.cost ? [c.cost] : []));
  if (costs.length === 0) return undefined;
  return costs.reduce(
    (acc, c) => ({
      usd: acc.usd + c.usd,
      inputTokens: acc.inputTokens + c.inputTokens,
      outputTokens: acc.outputTokens + c.outputTokens,
    }),
    { usd: 0, inputTokens: 0, outputTokens: 0 },
  );
}
