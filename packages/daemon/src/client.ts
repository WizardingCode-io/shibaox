import { request as httpRequest } from 'node:http';
import type { RunState } from '@shibaox/core';
import type { ScheduleRow } from '@shibaox/persistence-sqlite';
import type { InboxItem } from './inbox.js';
import type { RunSummaryPlus, SubmitRequest } from './run-manager.js';
import type { Envelope, Health } from './server.js';

export type { Envelope, Health } from './server.js';

export class DaemonHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonHttpError';
  }
}

/** The daemon is not listening on the socket. */
export class DaemonUnavailableError extends Error {
  constructor(
    readonly socketPath: string,
    cause: unknown,
  ) {
    super(`no shibaox daemon at ${socketPath}`, { cause });
    this.name = 'DaemonUnavailableError';
  }
}

interface Response {
  status: number;
  body: unknown;
}

/** A thin client for the daemon's Unix-socket API (Node's `fetch` cannot use sockets). */
export class DaemonClient {
  constructor(readonly socketPath: string) {}

  private call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
              : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              // non-JSON body (should not happen)
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
          res.on('error', reject);
        },
      );
      req.on('error', (e) => reject(new DaemonUnavailableError(this.socketPath, e)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call(method, path, body);
    if (r.status >= 400) {
      const err = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new DaemonHttpError(r.status, err?.code ?? 'error', err?.message ?? `HTTP ${r.status}`);
    }
    return r.body as T;
  }

  health(): Promise<Health> {
    return this.json('GET', '/health');
  }
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }> {
    return this.json('POST', '/runs', req);
  }
  listRuns(q: { status?: string; org?: string } = {}): Promise<RunSummaryPlus[]> {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.org) p.set('org', q.org);
    const qs = p.toString();
    return this.json('GET', `/runs${qs ? `?${qs}` : ''}`);
  }
  getRun(id: string): Promise<RunState> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}`);
  }
  cancel(id: string): Promise<RunState> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/cancel`);
  }
  resume(id: string, o: { budgetUsd?: number } = {}): Promise<RunState> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/resume`, o);
  }
  inbox(): Promise<InboxItem[]> {
    return this.json('GET', '/inbox');
  }
  answer(
    id: string,
    a: { approved: boolean; note?: string; via?: 'cli' | 'api' },
  ): Promise<{ runId: string; kind: 'human' | 'approval' }> {
    return this.json('POST', `/inbox/${encodeURIComponent(id)}`, { via: 'api', ...a });
  }
  schedules(): Promise<ScheduleRow[]> {
    return this.json('GET', '/schedules');
  }
  addSchedule(
    s: Omit<ScheduleRow, 'id' | 'createdAt' | 'enabled' | 'lastRunId'> & { enabled?: boolean },
  ): Promise<ScheduleRow> {
    return this.json('POST', '/schedules', s);
  }
  removeSchedule(id: string): Promise<void> {
    return this.json('DELETE', `/schedules/${encodeURIComponent(id)}`);
  }
  runSchedule(id: string): Promise<{ runId: string }> {
    return this.json('POST', `/schedules/${encodeURIComponent(id)}/run`);
  }
  shutdown(o: { force?: boolean } = {}): Promise<void> {
    return this.json('POST', '/shutdown', o);
  }

  /** SSE frames of a run, from `since` (a frame `seq`), until the run ends or `signal` aborts. */
  async *events(
    id: string,
    o: { since?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<Envelope> {
    const path = `/runs/${encodeURIComponent(id)}/events${o.since ? `?since=${o.since}` : ''}`;
    const frames: Envelope[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const req = httpRequest({ socketPath: this.socketPath, path, method: 'GET' }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
            error?: { code?: string; message?: string };
          };
          failure = new DaemonHttpError(
            res.statusCode ?? 0,
            body.error?.code ?? 'error',
            body.error?.message ?? 'error',
          );
          done = true;
          notify();
        });
        return;
      }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = frame
            .split('\n')
            .find((l) => l.startsWith('data: '))
            ?.slice(6);
          if (data) frames.push(JSON.parse(data) as Envelope);
          idx = buffer.indexOf('\n\n');
        }
        notify();
      });
      res.on('end', () => {
        done = true;
        notify();
      });
      res.on('error', (e) => {
        failure = e;
        done = true;
        notify();
      });
    });
    req.on('error', (e) => {
      failure = o.signal?.aborted ? undefined : new DaemonUnavailableError(this.socketPath, e);
      done = true;
      notify();
    });
    const onAbort = () => req.destroy();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    req.end();
    try {
      while (true) {
        while (frames.length > 0) {
          const f = frames.shift() as Envelope;
          yield f;
          if (f.kind === 'end') return;
        }
        if (done) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    } finally {
      o.signal?.removeEventListener('abort', onAbort);
      req.destroy();
    }
  }
}

/**
 * A client to a running daemon: connects, or spawns one (`spawn`) and waits for `/health`.
 * Refuses a daemon older than this CLI for write commands (the caller decides).
 */
export async function ensureDaemon(o: {
  socketPath: string;
  spawn: () => void;
  timeoutMs?: number;
  onSpawn?: () => void;
}): Promise<DaemonClient> {
  const client = new DaemonClient(o.socketPath);
  try {
    await client.health();
    return client;
  } catch (e) {
    if (!(e instanceof DaemonUnavailableError)) throw e;
  }
  o.spawn();
  o.onSpawn?.();
  const deadline = Date.now() + (o.timeoutMs ?? 5000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      await client.health();
      return client;
    } catch (e) {
      if (!(e instanceof DaemonUnavailableError)) throw e;
    }
  }
  throw new Error(`Could not start the shibaox daemon (no answer on ${o.socketPath})`);
}
