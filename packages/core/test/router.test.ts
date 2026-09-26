import { ModelsSchema, RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/index.js';

const providers = [
  { id: 'anthropic', configured: true },
  { id: 'anthropic-subscription', via_runtime: 'claude-code', configured: true },
  { id: 'ollama', configured: true },
  { id: 'openrouter', configured: false },
];
const models = ModelsSchema.parse({
  tiers: { strong: 'anthropic/claude-sonnet-5', cheap: 'ollama/llama3.2' },
  roles: { researcher: { model: 'anthropic-subscription/claude-sonnet-5' } },
});
const runtimes = ['claude-code', 'mock'];

describe('resolveModel', () => {
  it('maps a tier to a direct provider', () => {
    const r = resolveModel({
      role: RoleSchema.parse({ role: 'analyst', model_tier: 'cheap', runtime: 'direct' }),
      models,
      providers,
      runtimes,
    });
    expect(r.resolution).toEqual({
      kind: 'direct',
      ref: 'ollama/llama3.2',
      provider: 'ollama',
      model: 'llama3.2',
    });
  });
  it('routes via_runtime providers to their runtime', () => {
    const r = resolveModel({
      role: RoleSchema.parse({ role: 'researcher' }),
      models,
      providers,
      runtimes,
    });
    expect(r.resolution).toEqual({
      kind: 'runtime',
      runtime: 'claude-code',
      model: 'claude-sonnet-5',
    });
  });
  it('keeps claude-code for anthropic models when the role prefers it, otherwise goes direct with a warning', () => {
    const a = resolveModel({
      role: RoleSchema.parse({ role: 'backend', model_tier: 'strong', runtime: 'claude-code' }),
      models,
      providers,
      runtimes,
    });
    expect(a.resolution).toEqual({
      kind: 'runtime',
      runtime: 'claude-code',
      model: 'claude-sonnet-5',
    });
    const b = resolveModel({
      role: RoleSchema.parse({ role: 'backend', model_tier: 'cheap', runtime: 'claude-code' }),
      models,
      providers,
      runtimes,
    });
    expect(b.resolution.kind).toBe('direct');
    expect(b.warnings[0]).toContain('prefers runtime "claude-code"');
  });
  it('the direct flag rejects a via_runtime provider, but that provider still resolves via runtime without the flag', () => {
    const role = RoleSchema.parse({ role: 'researcher' });
    expect(() =>
      resolveModel({ role, models, providers, runtimes, defaultAdapter: 'direct' }),
    ).toThrow(
      /anthropic-subscription.*only reachable via runtime "claude-code".*cannot run directly/,
    );
    const r = resolveModel({ role, models, providers, runtimes });
    expect(r.resolution).toEqual({
      kind: 'runtime',
      runtime: 'claude-code',
      model: 'claude-sonnet-5',
    });
  });
  it('the CLI adapter flag wins', () => {
    expect(
      resolveModel({
        role: RoleSchema.parse({ role: 'x' }),
        models,
        providers,
        runtimes,
        defaultAdapter: 'mock',
      }).resolution,
    ).toEqual({ kind: 'runtime', runtime: 'mock' });
  });
  it('errors clearly on a missing tier or an unconfigured provider', () => {
    expect(() =>
      resolveModel({
        role: RoleSchema.parse({ role: 'x', model_tier: 'local' }),
        models,
        providers,
        runtimes,
      }),
    ).toThrow(/tiers.local/);
    const m2 = ModelsSchema.parse({ tiers: { strong: 'openrouter/openai/gpt-5' } });
    expect(() =>
      resolveModel({ role: RoleSchema.parse({ role: 'x' }), models: m2, providers, runtimes }),
    ).toThrow(/openrouter.*not configured/);
  });
});
