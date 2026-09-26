/**
 * Human-readable text for a model/provider error. The AI SDK's connection
 * errors end in an empty detail ("Cannot connect to API: ") and its API errors
 * do not mention the HTTP status, so the status code, URL and errno code of the
 * (last) underlying error are appended when present.
 */
export function describeError(err: unknown): string {
  const base = err instanceof Error ? err.message.trim() : String(err);
  const last = ((err as { lastError?: unknown } | null)?.lastError ?? err) as {
    statusCode?: unknown;
    url?: unknown;
    cause?: { code?: unknown };
  } | null;
  const status = typeof last?.statusCode === 'number' ? `HTTP ${last.statusCode}` : undefined;
  const extra = [status, last?.url, last?.cause?.code]
    .filter((x) => typeof x === 'string')
    .join(' ');
  return extra ? `${base} (${extra})` : base;
}
