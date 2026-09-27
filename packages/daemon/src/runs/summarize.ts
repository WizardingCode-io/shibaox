import { SUMMARY_PROMPT } from '@shibaox/core';
import { LlmClient, type ProviderRegistry } from '@shibaox/providers';
import type { Org } from '@shibaox/schemas';

/** A tier ref this registry can call directly (a key present, not a runtime-only provider). */
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

/**
 * Condenses a conversation transcript with the org's cheap tier (else strong). Throws when
 * neither can be called: the caller then condenses without a model.
 */
export function orgSummarizer(
  registry: () => ProviderRegistry,
): (transcript: string, org: Org) => Promise<string> {
  return async (transcript, org) => {
    const reg = registry();
    const ref = directRef(reg, org.models.tiers.cheap) ?? directRef(reg, org.models.tiers.strong);
    if (!ref) throw new Error('no direct model for the cheap or strong tier');
    const r = await new LlmClient(reg).generate(ref, {
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: transcript }],
      maxSteps: 1,
      maxRetries: 1,
    });
    return r.text;
  };
}
