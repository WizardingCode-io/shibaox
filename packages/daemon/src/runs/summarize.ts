import { SUMMARY_PROMPT } from '@shibaox/core';
import { LlmClient, type ProviderRegistry } from '@shibaox/providers';
import type { Org } from '@shibaox/schemas';

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
