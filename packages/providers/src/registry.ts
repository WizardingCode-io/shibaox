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
  /** A value of the environment this registry was built with (keys stay inside it). */
  envValue(name: string): string | undefined {
    return this.env[name];
  }
  /** The model's context window in tokens, when the catalog records it. */
  contextWindow(ref: string): number | undefined {
    let parsed: { provider: string; model: string };
    try {
      parsed = this.parseRef(ref);
    } catch {
      return undefined;
    }
    const entry = this.byId.get(parsed.provider);
    return entry?.context_window?.[parsed.model];
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

/** One model a run can be pointed at, with whether this environment can use it. */
export interface ModelChoice {
  ref: string;
  provider: string;
  model: string;
  configured: boolean;
  /** The runtime the provider goes through (`claude-code` for the Claude subscription). */
  runtime?: string;
  /** Environment variables missing for the provider. */
  missing?: string[];
  /** A server on this machine (LM Studio, Ollama): its models are discovered live. */
  local?: boolean;
  /** For a local provider: whether its server answered. */
  available?: boolean;
  /** Context window (tokens) when the provider's own listing says so. */
  contextWindow?: number;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
/** Remote listings are big and slow: kept for ten minutes per provider. */
const REMOTE_TTL_MS = 600_000;
const remoteCache = new Map<
  string,
  { at: number; models: { id: string; contextWindow?: number }[] }
>();

/** What OpenRouter offers, with the key: every model id and its context length. */
async function probeOpenRouter(
  e: ProviderEntry,
  apiKey: string,
  o: { fetch: typeof fetch; timeoutMs: number },
): Promise<{ id: string; contextWindow?: number }[] | undefined> {
  const hit = remoteCache.get(e.id);
  if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.models;
  try {
    const res = await o.fetch(`${(e.base_url ?? OPENROUTER_API).replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { id?: unknown; context_length?: unknown }[] };
    const models = (json.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id)
      .map((m) => ({
        id: m.id as string,
        ...(typeof m.context_length === 'number' ? { contextWindow: m.context_length } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
    remoteCache.set(e.id, { at: Date.now(), models });
    return models;
  } catch {
    return undefined;
  }
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
/** Models a local server may list that are not chat models. */
const NOT_A_CHAT_MODEL = /whisper|embed|tts|rerank|speech|vision-encoder/i;

const isLocal = (e: ProviderEntry): boolean =>
  e.auth?.type === 'none' && typeof e.base_url === 'string' && LOCAL_URL.test(e.base_url);

/** The model ids an OpenAI-compatible server reports at `GET <base_url>/models`, or undefined when it does not answer. */
async function probeModels(
  baseUrl: string,
  o: { fetch: typeof fetch; timeoutMs: number },
): Promise<string[] | undefined> {
  try {
    const res = await o.fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { data?: { id?: unknown }[] };
    return (json.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((id) => id && !NOT_A_CHAT_MODEL.test(id));
  } catch {
    return undefined;
  }
}

/**
 * Every model a run can be pointed at: the catalog, plus what the local servers (LM Studio,
 * Ollama) say they have right now; a local server that does not answer keeps its catalog
 * models, marked unavailable.
 */
export async function discoverModels(
  registry: ProviderRegistry,
  o: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<ModelChoice[]> {
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 1500;
  const out: ModelChoice[] = [];
  for (const e of registry.list()) {
    if (e.kind === 'openrouter' && e.auth?.type === 'api_key') {
      // the whole OpenRouter catalogue once the key is there: the catalog's picks first
      const catalog = listModels(registry).filter((m) => m.provider === e.id);
      const apiKey = registry.isConfigured(e.id).ok ? registry.envValue(e.auth.env) : undefined;
      const remote = apiKey
        ? await probeOpenRouter(e, apiKey, { fetch: doFetch, timeoutMs: Math.max(timeoutMs, 4000) })
        : undefined;
      out.push(...catalog);
      for (const m of remote ?? [])
        if (!e.models.includes(m.id))
          out.push({
            ref: `${e.id}/${m.id}`,
            provider: e.id,
            model: m.id,
            configured: true,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          });
      continue;
    }
    if (!isLocal(e)) {
      out.push(...listModels(registry).filter((m) => m.provider === e.id));
      continue;
    }
    const found = e.base_url
      ? await probeModels(e.base_url, { fetch: doFetch, timeoutMs })
      : undefined;
    const available = found !== undefined;
    const ids = [...(found ?? []), ...e.models.filter((m) => !(found ?? []).includes(m))];
    for (const model of ids)
      out.push({
        ref: `${e.id}/${model}`,
        provider: e.id,
        model,
        configured: true,
        local: true,
        available,
      });
  }
  return out;
}

/** The runtimes a run can go through today (a provider on another runtime is not usable). */
export const KNOWN_RUNTIMES = ['claude-code'];

/** Every model the catalog names, with its state in this environment. */
export function listModels(
  registry: ProviderRegistry,
  runtimes: readonly string[] = KNOWN_RUNTIMES,
): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const e of registry.list())
    for (const model of e.models) {
      const c = registry.isConfigured(e.id);
      const runtimeMissing = e.via_runtime && !runtimes.includes(e.via_runtime);
      const missing = runtimeMissing ? [`runtime ${e.via_runtime}`] : c.missing;
      out.push({
        ref: `${e.id}/${model}`,
        provider: e.id,
        model,
        configured: c.ok && !runtimeMissing,
        ...(e.via_runtime ? { runtime: e.via_runtime } : {}),
        ...(missing.length > 0 ? { missing } : {}),
      });
    }
  return out;
}
