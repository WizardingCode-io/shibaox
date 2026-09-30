import type { RunState } from '@wizardingcode/shibaox-core';
import type {
  AuditDoc,
  Envelope,
  Health,
  InboxItem,
  OrgInfo,
  ProjectEntry,
  RunSummaryPlus,
  SubmitRequest,
} from '@wizardingcode/shibaox-daemon';

/** An error the daemon answered with (status, its code and message). */
export class AppHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppHttpError';
  }
}

export interface ModelRow {
  provider: string;
  model: string;
  ref: string;
  configured: boolean;
  [k: string]: unknown;
}

/**
 * The daemon's API from the browser: JSON over `fetch` with the bearer token, and the run
 * event stream (SSE) read through `fetch` too, since `EventSource` cannot send a header.
 */
export class AppClient {
  readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(
    base: string,
    readonly token?: string,
    o: { fetch?: typeof fetch } = {},
  ) {
    this.base = base.replace(/\/+$/, '');
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (r.status >= 400) {
      const err = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new AppHttpError(r.status, err?.code ?? 'error', err?.message ?? `HTTP ${r.status}`);
    }
    return parsed as T;
  }

  health(): Promise<Health> {
    return this.json('GET', '/health');
  }
  listRuns(
    q: { status?: string; org?: string; parent?: string; thread?: string } = {},
  ): Promise<RunSummaryPlus[]> {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const qs = p.toString();
    return this.json('GET', `/runs${qs ? `?${qs}` : ''}`);
  }
  getRun(id: string): Promise<RunState> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}`);
  }
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }> {
    return this.json('POST', '/runs', req);
  }
  audit(id: string): Promise<AuditDoc> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}/audit`);
  }
  /** The audit as a Markdown document (the token travels with the request). */
  async auditMarkdown(id: string): Promise<string> {
    const r = await this.fetchImpl(`${this.base}/runs/${encodeURIComponent(id)}/audit?format=md`, {
      method: 'GET',
      headers: this.headers(),
    });
    const text = await r.text();
    if (r.status >= 400)
      throw new AppHttpError(r.status, 'error', text.slice(0, 200) || `HTTP ${r.status}`);
    return text;
  }
  steer(id: string, o: { nodeId?: string; note: string }): Promise<RunState> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/steer`, { ...o, via: 'api' });
  }
  cancel(id: string): Promise<unknown> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/cancel`);
  }
  resume(id: string, o: { budgetUsd?: number } = {}): Promise<unknown> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/resume`, o);
  }
  inbox(): Promise<InboxItem[]> {
    return this.json('GET', '/inbox');
  }
  answer(id: string, a: { approved: boolean; note?: string }): Promise<unknown> {
    return this.json('POST', `/inbox/${encodeURIComponent(id)}`, { via: 'api', ...a });
  }
  models(): Promise<ModelRow[]> {
    return this.json('GET', '/models');
  }
  projects(): Promise<ProjectEntry[]> {
    return this.json('GET', '/projects');
  }
  defaultOrg(): Promise<{ root: string; created: boolean }> {
    return this.json('GET', '/orgs/default');
  }
  orgInfo(root: string): Promise<OrgInfo> {
    return this.json('GET', `/orgs/info?org=${encodeURIComponent(root)}`);
  }

  /** SSE frames of a run after `since` (a frame cursor), until the end frame or `signal`. */
  async *stream(
    id: string,
    o: { since?: string; signal?: AbortSignal } = {},
  ): AsyncIterable<Envelope> {
    const q = new URLSearchParams();
    if (o.since) q.set('since', o.since);
    const qs = q.toString();
    const r = await this.fetchImpl(
      `${this.base}/runs/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream' }),
        signal: o.signal,
      },
    );
    if (r.status >= 400) {
      let body: { error?: { code?: string; message?: string } } = {};
      try {
        body = (await r.json()) as typeof body;
      } catch {
        // a non-JSON error body: keep the status only
      }
      throw new AppHttpError(r.status, body.error?.code ?? 'error', body.error?.message ?? 'error');
    }
    const reader = r.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = frame
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6);
          if (data) {
            let e: Envelope | undefined;
            try {
              e = JSON.parse(data) as Envelope;
            } catch {
              e = undefined; // a torn frame is skipped, never fatal
            }
            if (e) {
              yield e;
              if (e.kind === 'end') return;
            }
          }
          idx = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }
}
