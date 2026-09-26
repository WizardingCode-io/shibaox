import { loadCatalog, ProviderRegistry } from '@shibaox/providers';
import { describe, expect, it } from 'vitest';
import { testProvider } from '../src/commands/providers.js';

// Opt-in: runs only with SHIBAOX_REAL_TESTS=1 and the provider's credentials set.
const reg = new ProviderRegistry(loadCatalog());
for (const id of ['openrouter', 'groq', 'anthropic', 'ollama']) {
  describe.skipIf(!reg.isConfigured(id).ok || process.env.SHIBAOX_REAL_TESTS !== '1')(
    `real: ${id}`,
    () => {
      it('answers a short prompt', async () => {
        const r = await testProvider(reg, id);
        expect(r.ok, r.error).toBe(true);
      }, 60_000);
    },
  );
}
