import type { LanguageModel } from 'ai';
import type { ProviderEntry } from './catalog-schema.js';
import { FACTORIES } from './factories.js';

const REQUIRED_ENV: Record<'aws' | 'gcp' | 'azure', string[]> = {
  aws: ['AWS_REGION'],
  gcp: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
  azure: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
};

export class ProviderRegistry {
  private readonly byId = new Map<string, ProviderEntry>();
  constructor(
    entries: ProviderEntry[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    for (const e of entries) this.byId.set(e.id, e);
  }
  list(): ProviderEntry[] {
    return [...this.byId.values()];
  }
  get(id: string): ProviderEntry {
    const e = this.byId.get(id);
    if (!e) throw new Error(`unknown provider "${id}" (see: shibaox providers list)`);
    return e;
  }
  parseRef(ref: string): { provider: string; model: string } {
    const i = ref.indexOf('/');
    if (i <= 0 || i === ref.length - 1)
      throw new Error(`model ref "${ref}" must look like <provider>/<model>`);
    return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
  }
  /** Whether the model at `ref` can be given function/tool definitions (`entry.capabilities.tools`). */
  supportsTools(ref: string): boolean {
    const { provider } = this.parseRef(ref);
    return this.get(provider).capabilities.tools;
  }
  resolveBaseUrl(e: ProviderEntry): string | undefined {
    if (e.base_url_env) return this.env[e.base_url_env] ?? undefined;
    return e.base_url;
  }
  isConfigured(id: string): { ok: boolean; missing: string[] } {
    const e = this.get(id);
    const missing: string[] = [];
    if (e.via_runtime) return { ok: true, missing };
    if (e.auth?.type === 'api_key' && !this.env[e.auth.env]) missing.push(e.auth.env);
    if (e.auth && e.auth.type !== 'api_key' && e.auth.type !== 'none')
      for (const v of REQUIRED_ENV[e.auth.type]) if (!this.env[v]) missing.push(v);
    if (
      e.auth?.type === 'aws' &&
      !this.env.AWS_BEARER_TOKEN_BEDROCK &&
      !(this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY)
    )
      missing.push('AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK');
    if (e.base_url_env && !this.env[e.base_url_env]) missing.push(e.base_url_env);
    return { ok: missing.length === 0, missing };
  }
  model(ref: string): LanguageModel {
    const { provider, model } = this.parseRef(ref);
    const e = this.get(provider);
    if (e.via_runtime)
      throw new Error(
        `provider "${e.id}" is a via_runtime provider (${e.via_runtime}); it cannot be used as a direct model`,
      );
    const cfg = this.isConfigured(e.id);
    if (!cfg.ok)
      throw new Error(`provider "${e.id}" is not configured: set ${cfg.missing.join(', ')}`);
    const apiKey =
      e.auth?.type === 'api_key'
        ? this.env[e.auth.env]
        : e.auth?.type === 'none'
          ? 'local'
          : undefined;
    return FACTORIES[e.kind as NonNullable<ProviderEntry['kind']>]({
      entry: e,
      model,
      apiKey,
      baseURL: this.resolveBaseUrl(e),
      env: this.env,
    });
  }
  estimateCost(
    ref: string,
    usage: { inputTokens: number; outputTokens: number },
  ): number | undefined {
    const { provider, model } = this.parseRef(ref);
    const p = this.get(provider).pricing[model];
    if (!p) return undefined;
    return (
      (usage.inputTokens / 1_000_000) * p.input_per_m +
      (usage.outputTokens / 1_000_000) * p.output_per_m
    );
  }
}
