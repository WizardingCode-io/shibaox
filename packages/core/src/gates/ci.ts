import { runArgv } from '../executors/code.js';
import type { RunState } from '../run/state.js';
import type { CheckRunner } from './engine.js';

/** The pull request a run works on: the `pr` node's output, else `#N` or a PR URL in the request, else the run branch. */
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
      return { number: out.number, url: out.url, ref: String(out.number) };
  }
  const spec = typeof state.input.spec === 'string' ? state.input.spec : '';
  const url = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/.exec(spec);
  if (url) return { number: Number(url[1]), url: url[0], ref: url[1] as string };
  const hash = /(?:^|[\s(])#(\d+)\b/.exec(spec);
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

/**
 * The `ci` check: asks GitHub about the pull request's checks (`gh pr checks`) until none is
 * pending, then passes when every one passed or was skipped. A run without a pull request
 * passes with a note (nothing to wait for).
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
    const skip = (evidence: string) => ({
      name: check.name,
      type: 'ci' as const,
      passed: true,
      skipped: true,
      evidence,
    });
    if (!pr)
      return skip('no pull request for this run (no pr node, no #N in the request, no branch)');
    const started = now();
    for (;;) {
      const r = await exec({
        argv: ['gh', 'pr', 'checks', pr.ref, '--json', 'name,state,bucket,link'],
        cwd: ctx.workspace,
        timeoutMs: 60_000,
        env: ctx.env,
      });
      if (r.exitCode !== 0) {
        const msg = (r.stderr || r.stdout).trim();
        if (/no pull requests? found|could not find|not found/i.test(msg))
          return skip(`no pull request: ${msg.slice(0, 200)}`);
        if (/no checks reported/i.test(msg))
          return skip(`no checks on the pull request: ${msg.slice(0, 200)}`);
        return {
          name: check.name,
          type: 'ci' as const,
          passed: false,
          skipped: false,
          evidence: `gh pr checks failed: ${msg.slice(-800)}`,
          suggestion: 'Check gh auth and the repository; the checks could not be read.',
        };
      }
      let checks: GhCheck[] = [];
      try {
        checks = JSON.parse(r.stdout) as GhCheck[];
      } catch {
        checks = [];
      }
      const line = (c: GhCheck) =>
        `${c.bucket === 'pass' ? '✓' : c.bucket === 'fail' || c.bucket === 'cancel' ? '✗' : c.bucket === 'skipping' ? '–' : '…'} ${c.name} (${c.state.toLowerCase()})${c.link ? ` ${c.link}` : ''}`;
      const evidence = checks.map(line).join('\n') || 'no checks reported';
      const pending = checks.filter((c) => c.bucket === 'pending');
      if (pending.length === 0) {
        const failed = checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
        return {
          name: check.name,
          type: 'ci' as const,
          passed: failed.length === 0,
          skipped: false,
          evidence: `${pr.url ?? `PR ${pr.ref}`}\n${evidence}`,
          suggestion: failed.length
            ? `Fix the failing checks: ${failed.map((c) => c.name).join(', ')}`
            : undefined,
        };
      }
      if (now() - started >= check.timeout_ms)
        return {
          name: check.name,
          type: 'ci' as const,
          passed: false,
          skipped: false,
          evidence: `still pending after ${Math.round(check.timeout_ms / 60_000)} min: ${pending.map((c) => c.name).join(', ')}\n${evidence}`,
          suggestion: 'The checks did not finish in time; look at the workflow runs.',
        };
      ctx.log(`[ci] ${pending.length} check(s) pending: ${pending.map((c) => c.name).join(', ')}`);
      await sleep(check.interval_ms);
    }
  };
}

export const ciCheckRunner: CheckRunner = makeCiCheckRunner();
