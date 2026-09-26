import { describeError, generate, loadCatalog, ProviderRegistry } from '@shibaox/providers';

export interface ProviderTestResult {
  ok: boolean;
  model?: string;
  text?: string;
  error?: string;
  ms?: number;
}

/** One line per catalog entry: id, configuration status and whether its URL is unverified. */
export function formatProviderList(reg: ProviderRegistry, onlyConfigured = false): string[] {
  const rows: string[] = [];
  for (const e of reg.list()) {
    const cfg = reg.isConfigured(e.id);
    if (onlyConfigured && !cfg.ok) continue;
    const status = e.via_runtime
      ? `via runtime ${e.via_runtime}`
      : cfg.ok
        ? 'configured'
        : `missing ${cfg.missing.join(', ')}`;
    rows.push(
      `${e.id.padEnd(30)} ${status.padEnd(44)} ${e.verify ? 'unverified URL' : ''}`.trimEnd(),
    );
  }
  return rows;
}

/** Makes one short real call to `id` (default model: the first in the catalog entry). */
export async function testProvider(
  reg: ProviderRegistry,
  id: string,
  model?: string,
): Promise<ProviderTestResult> {
  let e: ReturnType<ProviderRegistry['get']>;
  try {
    e = reg.get(id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (e.via_runtime)
    return {
      ok: false,
      error: `provider "${id}" is used through the ${e.via_runtime} runtime; test it with that CLI`,
    };
  const cfg = reg.isConfigured(id);
  if (!cfg.ok)
    return {
      ok: false,
      error: `provider "${id}" is not configured: set ${cfg.missing.join(', ')}`,
    };
  const m = model ?? e.models[0];
  if (!m) return { ok: false, error: `provider "${id}" has no default model; pass --model` };
  const t0 = Date.now();
  try {
    const r = await generate({
      model: reg.model(`${id}/${m}`),
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
      maxSteps: 1,
      maxRetries: 0, // a connectivity check: report the first failure, do not retry
    });
    return { ok: true, model: m, text: r.text.trim(), ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      model: m,
      error: describeError(err),
      ms: Date.now() - t0,
    };
  }
}

export function providersListCommand(o: { configured?: boolean }): void {
  const lines = formatProviderList(new ProviderRegistry(loadCatalog()), o.configured);
  if (lines.length === 0) console.log('No configured providers (see: shibaox providers list).');
  for (const l of lines) console.log(l);
}

export async function providersTestCommand(id: string, o: { model?: string }): Promise<number> {
  const r = await testProvider(new ProviderRegistry(loadCatalog()), id, o.model);
  if (r.ok) {
    console.log(`ok  ${id}/${r.model}  ${r.ms}ms  → ${JSON.stringify(r.text)}`);
    return 0;
  }
  console.error(`failed  ${id}${r.model ? `/${r.model}` : ''}: ${r.error}`);
  return 1;
}
