import { type DescribeRequest, SUMMARY_PROMPT } from '@wizardingcode/shibaox-core';
import { LlmClient, type ProviderRegistry } from '@wizardingcode/shibaox-providers';
import type { Org } from '@wizardingcode/shibaox-schemas';

/** A ref this registry can call directly (a key present, not a runtime-only provider). */
function directRef(registry: ProviderRegistry, ref: string | undefined): string | undefined {
  if (!ref?.includes('/')) return undefined;
  try {
    const { provider } = registry.parseRef(ref);
    const entry = registry.get(provider);
    if (entry.via_runtime || !registry.isConfigured(provider).ok) return undefined;
    return ref;
  } catch {
    return undefined;
  }
}

/** A summariser must answer within this, or the turn goes on without it (condensed instead). */
const SUMMARY_TIMEOUT_MS = 20_000;
/** A summary is short by contract; the cap keeps a chatty model from writing an essay. */
const SUMMARY_MAX_TOKENS = 600;

export type Summarizer = (transcript: string) => Promise<string>;

/**
 * The summariser for a conversation: the org's cheap tier when this registry can call it,
 * else strong, else the run's own model choice; none when nothing is callable (the caller
 * then condenses without a model).
 */
export function orgSummarizer(
  registry: () => ProviderRegistry,
): (org: Org, model: string | undefined) => Summarizer | undefined {
  return (org, model) => {
    const reg = registry();
    const ref =
      directRef(reg, org.models.tiers.cheap) ??
      directRef(reg, org.models.tiers.strong) ??
      directRef(reg, model);
    if (!ref) return undefined;
    return async (transcript) => {
      const r = await new LlmClient(reg).generate(ref, {
        system: SUMMARY_PROMPT,
        messages: [{ role: 'user', content: transcript }],
        maxSteps: 1,
        maxRetries: 1,
        maxOutputTokens: SUMMARY_MAX_TOKENS,
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
      // a thinking model's reasoning is not the summary
      return r.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    };
  };
}

const COMMIT_PROMPT =
  'Write the git commit message for this change: a title of at most 72 characters in the imperative (a conventional prefix like feat:, fix:, chore: when it fits), a blank line, then a short body saying what changed and why, from the request and the diff. Plain text only, no code fences, no quotes around it.';
const PR_PROMPT =
  'Write the pull request description for this change in Markdown: a one-paragraph summary, a "Changes" list, and a "How to test" section, from the request, what each step did and the diff. No title line: the title is set separately.';

/** Writes commit messages and PR bodies with the same model choice as the summariser. */
export function changeDescriber(
  registry: () => ProviderRegistry,
): (org: Org, model: string | undefined) => ((r: DescribeRequest) => Promise<string>) | undefined {
  return (org, model) => {
    const reg = registry();
    const ref =
      directRef(reg, org.models.tiers.cheap) ??
      directRef(reg, org.models.tiers.strong) ??
      directRef(reg, model);
    if (!ref) return undefined;
    return async (r) => {
      const steps = r.summaries.map((s) => `- ${s.nodeId}: ${s.summary}`).join('\n');
      const out = await new LlmClient(reg).generate(ref, {
        system: r.kind === 'commit' ? COMMIT_PROMPT : PR_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Request:\n${r.spec}\n\nSteps:\n${steps || '(none)'}\n\nDiff:\n${r.diff.slice(0, 40_000)}`,
          },
        ],
        maxSteps: 1,
        maxRetries: 1,
        maxOutputTokens: r.kind === 'commit' ? 400 : 900,
        signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
      });
      return out.text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^```[a-z]*\n?|\n?```$/g, '')
        .trim();
    };
  };
}
