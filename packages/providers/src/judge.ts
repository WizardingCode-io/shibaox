import type { CheckContext, CheckRunner } from '@shibaox/core';
import { z } from 'zod';
import { describeError } from './errors.js';
import type { GenerateResult, LlmClient } from './llm-client.js';

const Verdict = z.object({
  passed: z.boolean(),
  evidence: z.string(),
  suggestion: z.string().optional(),
});
export const JUDGE_SYSTEM =
  'You are a strict but fair technical reviewer. Judge the work against the rubric using only the provided context. Answer with the JSON object requested.';

export function judgeContext(ctx: CheckContext): string {
  const outputs = Object.fromEntries(
    Object.entries(ctx.state.nodes)
      .filter(([, n]) => n.output !== undefined)
      .map(([id, n]) => [id, n.output]),
  );
  return `## request\n${JSON.stringify(ctx.state.input)}\n\n## outputs\n${JSON.stringify(outputs).slice(0, 60_000)}\n\n## last gate report\n${JSON.stringify(ctx.state.lastGateReport ?? null).slice(0, 20_000)}`;
}

export function judgeCheckRunner(client: LlmClient, ref: string): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'judge') throw new Error('judgeCheckRunner got a non-judge check');
    let r: GenerateResult<z.infer<typeof Verdict>> & { cost?: number };
    try {
      r = await client.generate<z.infer<typeof Verdict>>(ref, {
        system: JUDGE_SYSTEM,
        messages: [{ role: 'user', content: `Rubric:\n${check.rubric}\n\n${judgeContext(ctx)}` }],
        output: Verdict,
        signal: ctx.signal,
      });
    } catch (e) {
      return {
        name: check.name,
        type: 'judge',
        passed: false,
        skipped: false,
        evidence: `judge ${ref} failed: ${describeError(e)}`,
      };
    }
    const v = r.output ?? { passed: false, evidence: 'judge returned no structured verdict' };
    return {
      name: check.name,
      type: 'judge',
      passed: v.passed,
      skipped: false,
      evidence: v.evidence,
      suggestion: v.suggestion,
      cost: {
        usd: r.cost ?? 0,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      },
    };
  };
}
