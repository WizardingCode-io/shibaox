import { noul, score } from '@typesafe-ai/sdk';
import type { CheckContext, CheckRunner } from '@wizardingcode/shibaox-core';
import type { CheckResult } from '@wizardingcode/shibaox-schemas';
import { addCost, gateByConfidence, type JevClient, truncateState } from './client.js';

const DIFF_MAX_CHARS = 60_000;

async function stateFor(ctx: CheckContext): Promise<string> {
  const spec = String(ctx.state.input.spec ?? JSON.stringify(ctx.state.input));
  const output = JSON.stringify(
    Object.fromEntries(
      Object.entries(ctx.state.nodes)
        .filter(([, n]) => n.output !== undefined)
        .map(([id, n]) => [id, n.output]),
    ),
  );
  const diffText = ctx.diff ? (await ctx.diff()).slice(0, DIFF_MAX_CHARS) : undefined;
  const gateReport = ctx.state.lastGateReport
    ? JSON.stringify(ctx.state.lastGateReport)
    : undefined;
  const diff = [diffText, gateReport ? `## last gate report\n${gateReport}` : undefined]
    .filter((s): s is string => Boolean(s))
    .join('\n\n');
  return truncateState({ spec, output, diff: diff || undefined });
}

export function jevCheckRunner(
  client: JevClient,
  opts: { escalate?: CheckRunner } = {},
): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'jev') throw new Error('jevCheckRunner got a non-jev check');
    const state = await stateFor(ctx);
    const q =
      check.kind === 'score'
        ? score(check.question, ['fails', 'partially', 'fully'])
        : noul(check.question);
    const r = await client.fanOut(state, { check: q }, { signal: ctx.signal });
    const a = r.answers.check as { noul?: number; score?: number; confidence?: number };
    const confidence = check.kind === 'score' ? (a.score ?? 0) / 2 : (a.noul ?? 0);
    const cost = {
      usd: r.cost,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    };
    const verdict = gateByConfidence(confidence, check.threshold);
    const base: CheckResult = {
      name: check.name,
      type: 'jev',
      passed: verdict === 'pass',
      skipped: false,
      confidence,
      cost,
      evidence: `jev ${check.kind} = ${confidence.toFixed(2)} (threshold ${check.threshold})`,
    };
    if (verdict === 'escalate' && opts.escalate) {
      const e = await opts.escalate(
        { name: check.name, type: 'judge', role: 'team-leader', rubric: check.question },
        ctx,
      );
      return {
        ...e,
        name: check.name,
        type: 'jev',
        confidence,
        cost: addCost(cost, e.cost),
        evidence: `escalated to judge (jev ${confidence.toFixed(2)}): ${e.evidence}`,
      };
    }
    if (verdict !== 'pass') {
      return {
        ...base,
        suggestion:
          verdict === 'escalate'
            ? 'Confidence in the grey zone: configure a judge runner to escalate, or improve the output'
            : 'Address the question in the check and re-run',
      };
    }
    return base;
  };
}
