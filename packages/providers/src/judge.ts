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

const DIFF_MAX_CHARS = 60_000;

export async function judgeContext(ctx: CheckContext): Promise<string> {
  const outputs = Object.fromEntries(
    Object.entries(ctx.state.nodes)
      .filter(([, n]) => n.output !== undefined)
      .map(([id, n]) => [id, n.output]),
  );
  const diff = ctx.diff ? await ctx.diff() : undefined;
  const diffSection = diff ? `\n\n## diff\n${diff.slice(0, DIFF_MAX_CHARS)}` : '';
  return `## request\n${JSON.stringify(ctx.state.input)}\n\n## outputs\n${JSON.stringify(outputs).slice(0, 60_000)}${diffSection}\n\n## last gate report\n${JSON.stringify(ctx.state.lastGateReport ?? null).slice(0, 20_000)}`;
}

export function judgeCheckRunner(client: LlmClient, ref: string): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'judge') throw new Error('judgeCheckRunner got a non-judge check');
    let r: GenerateResult<z.infer<typeof Verdict>> & { cost?: number };
    try {
      r = await client.generateObject(
        ref,
        {
          system: JUDGE_SYSTEM,
          messages: [
            { role: 'user', content: `Rubric:\n${check.rubric}\n\n${await judgeContext(ctx)}` },
          ],
          signal: ctx.signal,
        },
        Verdict,
      );
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

/** What a code review checks when the gate names no criteria. */
export const DEFAULT_REVIEW_CRITERIA = [
  'Scope: the change does what the request asks and nothing unrelated',
  'Correctness: the logic handles the normal and the edge cases; errors are handled, not swallowed',
  'Tests: the behaviour that changed is covered by tests that would fail without the change',
  'Hygiene: no debug leftovers, commented-out code, TODOs, secrets or credentials in the diff',
  'Clarity: names and structure make the change easy to follow; no needless duplication',
];

const Findings = z.object({
  findings: z.array(
    z.object({
      criterion: z.string(),
      passed: z.boolean(),
      evidence: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});

const REVIEW_SYSTEM =
  'You are a strict but fair code reviewer. Judge the change against each numbered criterion using only the provided context (request, outputs, diff). For every criterion answer passed true/false with concrete evidence (file, line, what you saw) and, when it fails, a suggestion the author can act on. Answer with the JSON object requested: { "findings": [ { "criterion", "passed", "evidence", "suggestion"? } ] } with one entry per criterion, in order, using the criterion text verbatim.';

/** A review check: the judge model answers criterion by criterion; all must pass. */
export function reviewCheckRunner(client: LlmClient, ref: string): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'review') throw new Error('reviewCheckRunner got a non-review check');
    const criteria = check.criteria ?? DEFAULT_REVIEW_CRITERIA;
    const list = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
    let r: GenerateResult<z.infer<typeof Findings>> & { cost?: number };
    try {
      r = await client.generateObject(
        ref,
        {
          system: REVIEW_SYSTEM,
          messages: [{ role: 'user', content: `Criteria:\n${list}\n\n${await judgeContext(ctx)}` }],
          signal: ctx.signal,
        },
        Findings,
      );
    } catch (e) {
      return {
        name: check.name,
        type: 'review',
        passed: false,
        skipped: false,
        evidence: `review ${ref} failed: ${describeError(e)}`,
      };
    }
    const findings = r.output?.findings ?? [];
    const key = (s: string) =>
      s
        .trim()
        .toLowerCase()
        .replace(/^\d+\.\s*/, '');
    const rows = criteria.map((c, i) => {
      const f =
        findings.find((x) => key(x.criterion) === key(c)) ??
        findings.find((x) => key(x.criterion).startsWith(key(c).split(':')[0] ?? '')) ??
        findings[i];
      return f && (key(f.criterion) === key(c) || findings.length === criteria.length)
        ? { criterion: c, passed: f.passed, evidence: f.evidence, suggestion: f.suggestion }
        : { criterion: c, passed: false, evidence: 'not reviewed', suggestion: undefined };
    });
    const passed = rows.every((x) => x.passed);
    const suggestions = rows
      .filter((x) => !x.passed && x.suggestion)
      .map((x) => `- ${x.suggestion}`);
    return {
      name: check.name,
      type: 'review',
      passed,
      skipped: false,
      evidence: rows.map((x) => `${x.passed ? '✓' : '✗'} ${x.criterion}: ${x.evidence}`).join('\n'),
      suggestion: suggestions.length > 0 ? suggestions.join('\n') : undefined,
      cost: {
        usd: r.cost ?? 0,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      },
    };
  };
}
