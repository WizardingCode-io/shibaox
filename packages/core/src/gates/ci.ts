import { runArgv } from '../executors/code.js';
import type { RunState } from '../run/state.js';
import type { CheckRunner } from './engine.js';

/**
 * The pull request a run works on: the `pr` node's output (number + URL), else a PR URL or
 * `PR #N` in the request, else the run branch. An issue number (`Issue #12`) is not one.
 */
export function pullRequestRef(
  state: RunState,
): { number?: number; url?: string; ref: string } | undefined {
  for (const n of Object.values(state.nodes)) {
    const out = n.output as { number?: unknown; url?: unknown } | undefined;
    if (
      out &&
      typeof out.number === 'number' &&
      typeof out.url === 'string' &&
      /\/pull\/\d+/.test(out.url)
    )
      return { number: out.number, url: out.url, ref: out.url };
  }
  const spec = typeof state.input.spec === 'string' ? state.input.spec : '';
  const url = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/.exec(spec);
  if (url) return { number: Number(url[1]), url: url[0], ref: url[0] };
  const hash = /(?<![\w#])(?<!issues?\s)#(\d+)\b/i.exec(spec);
  if (hash) return { number: Number(hash[1]), ref: hash[1] as string };
  if (state.branch) return { ref: state.branch };
  return undefined;
}

interface GhCheck {
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | string;
  link?: string;
}

const NO_PR = /no pull requests? found|could not resolve to a pullrequest/i;
const NO_CHECKS = /no checks reported/i;

/**
 * The `ci` check: asks GitHub about the pull request's checks (`gh pr checks`) until none is
 * pending, then passes when every one passed or was skipped. Checks that have not appeared
 * yet (a push a moment ago) are waited for during `grace_ms`, then the check passes with a
 * note. Anything else that goes wrong (no access, an answer that cannot be read) fails.
 */
export function makeCiCheckRunner(
  o: { exec?: typeof runArgv; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): CheckRunner {
  const exec = o.exec ?? runArgv;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  return async (check, ctx) => {
    if (check.type !== 'ci') throw new Error('ciCheckRunner got a non-ci check');
    const pr = pullRequestRef(ctx.state);
    const result = (r: {
      passed: boolean;
      skipped?: boolean;
      evidence: string;
      suggestion?: string;
    }) => ({
      name: check.name,
      type: 'ci' as const,
      skipped: false,
      ...r,
    });
    if (!pr)
      return result({
        passed: true,
        skipped: true,
        evidence: 'no pull request for this run (no pr node, no PR in the request, no branch)',
      });
    const started = now();
    const grace = check.grace_ms ?? 120_000;
    for (;;) {
      const r = await exec({
        argv: ['gh', 'pr', 'checks', pr.ref, '--json', 'name,state,bucket,link'],
        cwd: ctx.workspace,
        timeoutMs: 60_000,
        env: ctx.env,
      });
      const elapsed = now() - started;
      if (r.exitCode !== 0) {
        const msg = (r.stderr || r.stdout).trim();
        if (NO_PR.test(msg))
          return result({
            passed: true,
            skipped: true,
            evidence: `no pull request: ${msg.slice(0, 200)}`,
          });
        if (NO_CHECKS.test(msg)) {
          if (elapsed < grace) {
            ctx.log(`[ci] no checks yet on ${pr.ref}: waiting for them to appear`);
            await sleep(Math.min(check.interval_ms, 15_000));
            continue;
          }
          return result({
            passed: true,
            skipped: true,
            evidence: `no checks on the pull request after ${Math.round(grace / 1000)} s: ${msg.slice(0, 200)}`,
          });
        }
        return result({
          passed: false,
          evidence: `gh pr checks failed: ${msg.slice(-800)}`,
          suggestion: 'The checks could not be read: check gh auth and the repository access.',
        });
      }
      let checks: GhCheck[] | undefined;
      try {
        const parsed: unknown = JSON.parse(r.stdout);
        if (Array.isArray(parsed)) checks = parsed as GhCheck[];
      } catch {
        checks = undefined;
      }
      if (!checks)
        return result({
          passed: false,
          evidence: `gh pr checks answered something that is not a list of checks: ${r.stdout.slice(0, 300)}`,
          suggestion: 'Update gh (the --json output of `gh pr checks` is needed).',
        });
      if (checks.length === 0) {
        if (elapsed < grace) {
          ctx.log(`[ci] no checks yet on ${pr.ref}: waiting for them to appear`);
          await sleep(Math.min(check.interval_ms, 15_000));
          continue;
        }
        return result({
          passed: true,
          skipped: true,
          evidence: `no checks on the pull request after ${Math.round(grace / 1000)} s`,
        });
      }
      const line = (c: GhCheck) =>
        `${c.bucket === 'pass' ? '✓' : c.bucket === 'fail' || c.bucket === 'cancel' ? '✗' : c.bucket === 'skipping' ? '–' : '…'} ${c.name} (${String(c.state).toLowerCase()})${c.link ? ` ${c.link}` : ''}`;
      const evidence = checks.map(line).join('\n');
      const pending = checks.filter((c) => c.bucket === 'pending');
      if (pending.length === 0) {
        const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
        return result({
          passed: failed.length === 0,
          evidence: `${pr.url ?? `PR ${pr.ref}`}\n${evidence}`,
          suggestion: failed.length
            ? `Fix the failing checks: ${failed.map((c) => c.name).join(', ')}`
            : undefined,
        });
      }
      if (elapsed >= check.timeout_ms)
        return result({
          passed: false,
          evidence: `still pending after ${Math.round(check.timeout_ms / 60_000)} min: ${pending.map((c) => c.name).join(', ')}\n${evidence}`,
          suggestion: 'The checks did not finish in time; look at the workflow runs.',
        });
      ctx.log(`[ci] ${pending.length} check(s) pending: ${pending.map((c) => c.name).join(', ')}`);
      await sleep(check.interval_ms);
    }
  };
}

export const ciCheckRunner: CheckRunner = makeCiCheckRunner();
