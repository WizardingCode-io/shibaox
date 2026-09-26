import { loadCatalog, ProviderRegistry } from '@shibaox/providers';
import { startFakeOpenAI } from '@shibaox/providers/testing';
import { describe, expect, it } from 'vitest';
import { formatProviderList, testProvider } from '../src/commands/providers.js';

describe('providers command', () => {
  it('lists providers with configuration status and verify flag', () => {
    const lines = formatProviderList(
      new ProviderRegistry(loadCatalog(), { OPENROUTER_API_KEY: 'k' }),
    );
    expect(lines.find((l) => l.startsWith('openrouter'))).toMatch(/configured/);
    expect(lines.find((l) => l.startsWith('anthropic '))).toMatch(/missing ANTHROPIC_API_KEY/);
    expect(lines.find((l) => l.startsWith('anthropic-subscription'))).toMatch(
      /via runtime claude-code/,
    );
    expect(lines.find((l) => l.startsWith('kilocode'))).toMatch(/unverified/);
  });
  it('--configured keeps only configured providers', () => {
    const lines = formatProviderList(
      new ProviderRegistry(loadCatalog(), { OPENROUTER_API_KEY: 'k' }),
      true,
    );
    expect(lines.some((l) => l.startsWith('openrouter'))).toBe(true);
    expect(lines.some((l) => l.startsWith('anthropic '))).toBe(false);
  });
  it('testProvider makes one real call against the configured base url', async () => {
    const fake = await startFakeOpenAI(() => ({ content: 'pong' }));
    const reg = new ProviderRegistry(
      [
        {
          id: 'fake',
          name: 'Fake',
          kind: 'openai-compatible',
          base_url: fake.baseURL,
          auth: { type: 'none' },
          models: ['m'],
          pricing: {},
          verify: false,
        },
      ],
      {},
    );
    const r = await testProvider(reg, 'fake');
    expect(r).toMatchObject({ ok: true, model: 'm' });
    expect(r.text).toBe('pong');
    await fake.close();
  });
  it('testProvider fails fast with the missing env var', async () => {
    const r = await testProvider(new ProviderRegistry(loadCatalog(), {}), 'groq');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('GROQ_API_KEY');
  });
  it('testProvider refuses via_runtime providers', async () => {
    const r = await testProvider(new ProviderRegistry(loadCatalog(), {}), 'anthropic-subscription');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('claude-code');
  });
});
