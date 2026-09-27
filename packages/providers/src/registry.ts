import type { LanguageModel } from 'ai';
import type { ProviderEntry } from './catalog-schema.js';
import { FACTORIES } from './factories.js';

const REQUIRED_ENV: Record<'aws' | 'gcp' | 'azure', string[]> = {
  aws: ['AWS_REGION'],
  gcp: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
  azure: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
};

/** Price per million tokens, as the catalog records it. */
export interface Pricing {
  input_per_m: number;
  output_per_m: number;
}
/** What discovery learned about one model: the providers' own listings say more than the catalog. */
export interface LearnedModel {
  contextWindow?: number;
  pricing?: Pricing;
  /** Costs nothing: a local server, or a provider's free tier. */
  free?: boolean;
}
/**
 * Everything discovery learned, by ref, shared by every registry of the process: the daemon
 * builds a registry per run, and a run started after `/model` (or after the warm-up at
 * start) must cost and measure with what the providers said.
 */
const learned = new Map<string, LearnedModel>();
export function rememberModel(ref: string, info: LearnedModel): void {
  learned.set(ref, { ...learned.get(ref), ...info });
}
export const learnedModel = (ref: string): LearnedModel | undefined => learned.get(ref);
/** Tests only: forget everything discovery learned. */
export function forgetModels(): void {
  learned.clear();
}
const isLocalUrl = (url: string | undefined): boolean =>
  typeof url === 'string' && LOCAL_URL.test(url);
const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

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
  /** The model's context window in tokens: the catalog's, else what discovery learned. */
  contextWindow(ref: string): number | undefined {
    let parsed: { provider: string; model: string };
    try {
      parsed = this.parseRef(ref);
    } catch {
      return undefined;
    }
    const entry = this.byId.get(parsed.provider);
    return entry?.context_window?.[parsed.model] ?? learned.get(ref)?.contextWindow;
  }
  /** Whether the provider is a server on this machine (its models cost nothing). */
  isLocal(id: string): boolean {
    const e = this.byId.get(id);
    return e?.auth?.type === 'none' && isLocalUrl(e.base_url);
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
  /**
   * What a call cost, from the catalog's prices, else the prices discovery learned from the
   * provider; a local model costs nothing. Unknown when neither says.
   */
  estimateCost(
    ref: string,
    usage: { inputTokens: number; outputTokens: number },
  ): number | undefined {
    const { provider, model } = this.parseRef(ref);
    const known = learned.get(ref);
    const p =
      this.get(provider).pricing[model] ??
      known?.pricing ??
      (known?.free || this.isLocal(provider) ? { input_per_m: 0, output_per_m: 0 } : undefined);
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
  /** Price per million tokens when the provider's listing says so. */
  pricing?: Pricing;
  /** Costs nothing: a local server, or a free model of a provider. */
  free?: boolean;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1';
/** Remote listings are big and slow: kept for ten minutes per provider. */
const REMOTE_TTL_MS = 600_000;
interface RemoteModel {
  id: string;
  contextWindow?: number;
  pricing?: Pricing;
}
const remoteCache = new Map<string, { at: number; models: RemoteModel[] }>();

/** OpenRouter prices are USD per token, as strings ("0.0000003"); the catalog counts per million. */
function perMillion(v: unknown): number | undefined {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : undefined;
}

/** What OpenRouter offers, with the key: every model id, its context length and its prices. */
async function probeOpenRouter(
  e: ProviderEntry,
  apiKey: string,
  o: { fetch: typeof fetch; timeoutMs: number },
): Promise<RemoteModel[] | undefined> {
  const hit = remoteCache.get(e.id);
  if (hit && Date.now() - hit.at < REMOTE_TTL_MS) return hit.models;
  try {
    const res = await o.fetch(`${(e.base_url ?? OPENROUTER_API).replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: { id?: unknown; context_length?: unknown; pricing?: Record<string, unknown> }[];
    };
    const models = (json.data ?? [])
      .filter((m) => typeof m.id === 'string' && m.id)
      .map((m): RemoteModel => {
        const input = perMillion(m.pricing?.prompt);
        const output = perMillion(m.pricing?.completion);
        return {
          id: m.id as string,
          ...(typeof m.context_length === 'number' ? { contextWindow: m.context_length } : {}),
          ...(input !== undefined && output !== undefined
            ? { pricing: { input_per_m: input, output_per_m: output } }
            : {}),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    remoteCache.set(e.id, { at: Date.now(), models });
    for (const m of models)
      rememberModel(`${e.id}/${m.id}`, {
        contextWindow: m.contextWindow,
        pricing: m.pricing,
        free: m.pricing ? m.pricing.input_per_m === 0 && m.pricing.output_per_m === 0 : undefined,
      });
    return models;
  } catch {
    return undefined;
  }
}

/** Models a local server may list that are not chat models. */
const NOT_A_CHAT_MODEL = /whisper|embed|tts|rerank|speech|vision-encoder/i;

const isLocal = (e: ProviderEntry): boolean => e.auth?.type === 'none' && isLocalUrl(e.base_url);

/**
 * LM Studio's own listing (`/api/v0/models` next to the OpenAI-compatible `/v1`): the context
 * length each model is loaded with (else its maximum). Other local servers answer 404: nothing.
 */
async function probeLmStudioWindows(
  baseUrl: string,
  o: { fetch: typeof fetch; timeoutMs: number },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await o.fetch(`${baseUrl.replace(/\/v1\/?$/, '')}/api/v0/models`, {
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!res.ok) return out;
    const json = (await res.json()) as {
      data?: { id?: unknown; max_context_length?: unknown; loaded_context_length?: unknown }[];
    };
    for (const m of json.data ?? []) {
      const w =
        typeof m.loaded_context_length === 'number'
          ? m.loaded_context_length
          : typeof m.max_context_length === 'number'
            ? m.max_context_length
            : undefined;
      if (typeof m.id === 'string' && w) out.set(m.id, w);
    }
  } catch {
    // not LM Studio, or not answering: the window stays unknown
  }
  return out;
}

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
            ...(m.pricing ? { pricing: m.pricing } : {}),
            ...(m.pricing && m.pricing.input_per_m === 0 && m.pricing.output_per_m === 0
              ? { free: true }
              : {}),
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
    const windows =
      available && e.base_url
        ? await probeLmStudioWindows(e.base_url, { fetch: doFetch, timeoutMs })
        : new Map<string, number>();
    const ids = [...(found ?? []), ...e.models.filter((m) => !(found ?? []).includes(m))];
    for (const model of ids) {
      const contextWindow = windows.get(model);
      if (contextWindow) rememberModel(`${e.id}/${model}`, { contextWindow, free: true });
      out.push({
        ref: `${e.id}/${model}`,
        provider: e.id,
        model,
        configured: true,
        local: true,
        available,
        free: true,
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
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
