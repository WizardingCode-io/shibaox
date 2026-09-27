import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { discoverModels, listModels, loadCatalog, ProviderRegistry } from '../src/index.js';

describe('ProviderRegistry', () => {
  const reg = (env: Record<string, string> = {}) => new ProviderRegistry(loadCatalog(), env);
  it('parses refs where the model id may contain slashes', () => {
    expect(reg().parseRef('openrouter/anthropic/claude-sonnet-4.5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.5',
    });
    expect(() => reg().parseRef('nomodel')).toThrow(/<provider>\/<model>/);
  });
  it('reports missing env vars for api_key providers and ok for local ones', () => {
    expect(reg().isConfigured('openrouter')).toEqual({
      ok: false,
      missing: ['OPENROUTER_API_KEY'],
    });
    expect(reg({ OPENROUTER_API_KEY: 'k' }).isConfigured('openrouter')).toEqual({
      ok: true,
      missing: [],
    });
    expect(reg().isConfigured('ollama')).toEqual({ ok: true, missing: [] });
    expect(reg().isConfigured('bedrock').missing).toContain('AWS_REGION');
    expect(reg().isConfigured('cloudflare-gateway').missing).toContain('CLOUDFLARE_GATEWAY_URL');
  });
  it('prices the models named in the templates and README', () => {
    const M = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(reg().estimateCost('anthropic/claude-sonnet-5', M)).toBe(18);
    const expected: Record<string, number> = {
      'anthropic/claude-opus-5-5': 90,
      'anthropic/claude-haiku-4-5': 6,
      'openai/gpt-5': 11.25,
      'openai/gpt-5-mini': 2.25,
      'google/gemini-2.5-pro': 11.25,
      'google/gemini-2.5-flash': 2.8,
      'openrouter/openai/gpt-5': 11.25,
      'openrouter/anthropic/claude-sonnet-4.5': 18,
      'openrouter/meta-llama/llama-3.3-70b-instruct': 0.4,
      'openrouter/qwen/qwen3-coder': 1.5,
    };
    for (const [ref, usd] of Object.entries(expected))
      expect(reg().estimateCost(ref, M), ref).toBeCloseTo(usd);
    expect(reg().estimateCost('ollama/llama3.2', M)).toBeUndefined();
  });
  it('refuses to build a model for a via_runtime provider', () => {
    expect(() => reg().model('anthropic-subscription/claude-sonnet-4-5')).toThrow(/via_runtime/);
  });
  it('builds an AI SDK model for an openai-compatible provider and a native one', () => {
    const m1 = reg().model('ollama/llama3.2');
    expect(m1).toBeDefined();
    const m2 = reg({ ANTHROPIC_API_KEY: 'k' }).model('anthropic/claude-sonnet-4-5');
    expect(m2).toBeDefined();
  });
  it('throws a clear error when the provider is not configured', () => {
    expect(() => reg().model('anthropic/claude-sonnet-4-5')).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('forwards the injected AZURE_API_KEY to the azure factory instead of reading process.env', () => {
    const previous = process.env.AZURE_API_KEY;
    process.env.AZURE_API_KEY = 'WRONG-FROM-REAL-PROCESS-ENV';
    try {
      const m = reg({ AZURE_RESOURCE_NAME: 'r', AZURE_API_KEY: 'k' }).model('azure/gpt-5');
      expect(m).toBeDefined();
      // The azure provider resolves its "api-key" header lazily from `options.apiKey` (falling
      // back to real process.env.AZURE_API_KEY only when unset). Reading it here proves the
      // registry's injected env — not the real process env — is what actually gets used.
      const headers = (
        m as unknown as { config: { headers: () => Record<string, string> } }
      ).config.headers();
      expect(headers['api-key']).toBe('k');
    } finally {
      if (previous === undefined) delete process.env.AZURE_API_KEY;
      else process.env.AZURE_API_KEY = previous;
    }
    expect(reg({ AZURE_RESOURCE_NAME: 'r' }).isConfigured('azure').missing).toEqual([
      'AZURE_API_KEY',
    ]);
  });
  it('estimates cost from pricing when present', () => {
    const r = reg({ OPENROUTER_API_KEY: 'k' });
    const usd = r.estimateCost('openrouter/anthropic/claude-sonnet-4.5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(usd).toBeCloseTo(18);
    expect(
      r.estimateCost('ollama/llama3.2', { inputTokens: 10, outputTokens: 10 }),
    ).toBeUndefined();
  });
});

describe('context windows', () => {
  it('knows the window of catalog models and says nothing for the rest', () => {
    const reg = new ProviderRegistry(loadCatalog(), {});
    expect(reg.contextWindow('anthropic/claude-sonnet-5')).toBe(200_000);
    expect(reg.contextWindow('anthropic-subscription/claude-haiku-4-5')).toBe(200_000);
    expect(reg.contextWindow('openai/gpt-5')).toBe(400_000);
    expect(reg.contextWindow('xai/grok-4')).toBeUndefined();
    expect(reg.contextWindow('nope/x')).toBeUndefined();
  });
});

describe('listModels runtimes', () => {
  it('marks providers on runtimes this build lacks as not configured', () => {
    const reg = new ProviderRegistry(loadCatalog(), {});
    const models = listModels(reg);
    expect(models.find((m) => m.ref === 'anthropic-subscription/claude-sonnet-5')).toMatchObject({
      configured: true,
      runtime: 'claude-code',
    });
    expect(models.find((m) => m.ref === 'openai-codex-subscription/gpt-5-codex')).toMatchObject({
      configured: false,
      runtime: 'codex',
      missing: ['runtime codex'],
    });
  });
});

describe('discoverModels', () => {
  it('asks local OpenAI-compatible servers which models they have and merges them with the catalog', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/models')
        return res.end(
          JSON.stringify({
            data: [{ id: 'qwen/qwen3-coder-30b' }, { id: 'whisper-large-v3' }, { id: 'llama3.2' }],
          }),
        );
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const reg = new ProviderRegistry(
        [
          {
            id: 'lmstudio',
            name: 'LM Studio',
            kind: 'openai-compatible',
            base_url: `http://127.0.0.1:${port}/v1`,
            auth: { type: 'none' },
            models: ['llama3.2'],
            pricing: {},
            verify: false,
            context_window: {},
            capabilities: { tools: true },
          },
          {
            id: 'ollama',
            name: 'Ollama',
            kind: 'openai-compatible',
            base_url: 'http://127.0.0.1:1/v1', // nothing listens here
            auth: { type: 'none' },
            models: ['llama3.2'],
            pricing: {},
            verify: false,
            context_window: {},
            capabilities: { tools: true },
          },
        ],
        {},
      );
      const models = await discoverModels(reg, { timeoutMs: 1000 });
      const lm = models.filter((m) => m.provider === 'lmstudio');
      // discovered ids first, the catalog entry kept once, audio/embedding models left out
      expect(lm.map((m) => m.model)).toEqual(['qwen/qwen3-coder-30b', 'llama3.2']);
      expect(lm[0]).toMatchObject({
        ref: 'lmstudio/qwen/qwen3-coder-30b',
        configured: true,
        local: true,
        available: true,
      });
      const ol = models.filter((m) => m.provider === 'ollama');
      expect(ol).toEqual([
        {
          ref: 'ollama/llama3.2',
          provider: 'ollama',
          model: 'llama3.2',
          configured: true,
          local: true,
          available: false,
        },
      ]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
