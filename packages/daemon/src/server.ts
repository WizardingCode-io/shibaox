import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { type EventStore, isTerminal, type RunStatus, type StoredEvent } from '@shibaox/core';
import type { ScheduleRow } from '@shibaox/persistence-sqlite';
import { AlreadyResolvedError, type InboxService, NotFoundError } from './inbox.js';
import type { RunManager, SubmitRequest } from './run-manager.js';
import type { RuntimeEnvelope } from './runtime-buffer.js';

export interface Health {
  version: string;
  uptimeSeconds: number;
  runs: { running: number; queued: number; waiting: number };
  channels: string[];
}

/** One SSE frame: a persisted run event, a runtime event, or the end of a terminal run. */
export type Envelope =
  | { kind: 'run'; seq: number; event: StoredEvent }
  | { kind: 'runtime'; seq: number; event: RuntimeEnvelope }
  | { kind: 'end'; seq: number; status: RunStatus };

export interface SchedulesApi {
  list(): ScheduleRow[];
  add(s: Omit<ScheduleRow, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): ScheduleRow;
  remove(id: string): void;
  runNow(id: string): Promise<{ runId: string }>;
}

export interface ServerDeps {
  store: EventStore;
  runs: RunManager;
  inbox: InboxService;
  schedules: () => SchedulesApi | undefined;
  health: () => Health;
  onShutdown: (o: { force?: boolean }) => void;
  log: (line: string) => void;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const RUNTIME_SEQ_BASE = 1_000_000;
const MAX_BODY = 1_000_000;
const TEXT_LIMIT = 4096;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'bad_json', 'request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** Long texts are trimmed in the stream (the log keeps them). */
function trimRuntime(e: RuntimeEnvelope): RuntimeEnvelope {
  const ev = e.event;
  if (ev.type === 'text' && ev.text.length > TEXT_LIMIT)
    return { ...e, event: { ...ev, text: `${ev.text.slice(0, TEXT_LIMIT)}…` } };
  if (ev.type === 'tool_result') {
    const s = typeof ev.output === 'string' ? ev.output : (JSON.stringify(ev.output) ?? '');
    if (s.length > TEXT_LIMIT)
      return { ...e, event: { ...ev, output: `${s.slice(0, TEXT_LIMIT)}…` } };
  }
  return e;
}

/** Maps domain errors to HTTP statuses; anything unknown is a 400 for client mistakes we raise as plain Errors. */
function toHttp(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof NotFoundError) return new HttpError(404, 'not_found', e.message);
  if (e instanceof AlreadyResolvedError) return new HttpError(409, 'already_resolved', e.message);
  const message = e instanceof Error ? e.message : String(e);
  if (/ not found$/.test(message)) return new HttpError(404, 'not_found', message);
  if (
    /answer the pending approval|is paused on budget|already running|no longer exists/.test(message)
  )
    return new HttpError(409, 'conflict', message);
  return new HttpError(400, 'bad_request', message);
}

/**
 * The local API over a Unix socket: JSON in and out, SSE for `GET /runs/:id/events`. No
 * authentication: the socket is `0600`, only the same user reaches it.
 */
export class DaemonServer {
  private server: Server | undefined;
  private readonly sockets = new Set<import('node:net').Socket>();

  constructor(
    private readonly socketPath: string,
    private readonly deps: ServerDeps,
  ) {}

  /** Refuses when a live daemon owns the socket; removes a stale socket file. */
  async listen(): Promise<void> {
    if (existsSync(this.socketPath)) {
      if (await this.alive())
        throw new Error(`A shibaox daemon is already running (${this.socketPath})`);
      unlinkSync(this.socketPath);
    }
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => {
        const h = toHttp(e);
        if (!res.headersSent) send(res, h.status, { error: { code: h.code, message: h.message } });
        else res.end();
      });
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    chmodSync(this.socketPath, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
  }

  private alive(): Promise<boolean> {
    return new Promise((resolve) => {
      const s = connect(this.socketPath);
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://daemon');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    /** The first capture of `re` against the path, or undefined. */
    const param = (re: RegExp): string | undefined => {
      const r = re.exec(path);
      return r?.[1] === undefined ? undefined : decodeURIComponent(r[1]);
    };

    if (method === 'GET' && path === '/health') return send(res, 200, this.deps.health());
    if (method === 'POST' && path === '/runs') {
      const body = asRecord(await readBody(req));
      for (const k of ['orgRoot', 'project', 'workflow', 'input'])
        if (typeof body[k] !== 'string')
          throw new HttpError(400, 'bad_request', `"${k}" is required`);
      return send(res, 200, await this.deps.runs.submit(body as unknown as SubmitRequest));
    }
    if (method === 'GET' && path === '/runs') {
      const status = url.searchParams.get('status') ?? undefined;
      const orgRoot = url.searchParams.get('org') ?? undefined;
      return send(
        res,
        200,
        await this.deps.runs.list({ status: status as RunStatus | undefined, orgRoot }),
      );
    }
    const runGet = param(/^\/runs\/([^/]+)$/);
    if (runGet !== undefined && method === 'GET')
      return send(res, 200, await this.deps.runs.state(runGet));
    const runEvents = param(/^\/runs\/([^/]+)\/events$/);
    if (runEvents !== undefined && method === 'GET') return this.stream(req, res, runEvents, url);
    const runCancel = param(/^\/runs\/([^/]+)\/cancel$/);
    if (runCancel !== undefined && method === 'POST')
      return send(res, 200, await this.deps.runs.cancel(runCancel));
    const runResume = param(/^\/runs\/([^/]+)\/resume$/);
    if (runResume !== undefined && method === 'POST') {
      const body = asRecord(await readBody(req));
      const budgetUsd = typeof body.budgetUsd === 'number' ? body.budgetUsd : undefined;
      const runId = runResume;
      // validation errors surface now; the run itself continues in the background
      const done = this.deps.runs.resume(runId, { budgetUsd });
      const settled = await Promise.race([
        done.then(
          () => 'ok' as const,
          (e: unknown) => ({ error: e }),
        ),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), 50)),
      ]);
      if (settled !== 'ok' && settled !== 'pending') throw settled.error;
      done.catch(() => undefined);
      return send(res, 200, await this.deps.runs.state(runId));
    }
    if (method === 'GET' && path === '/inbox') return send(res, 200, await this.deps.inbox.list());
    const inboxId = param(/^\/inbox\/([^/]+)$/);
    if (inboxId !== undefined && method === 'POST') {
      const body = asRecord(await readBody(req));
      if (typeof body.approved !== 'boolean')
        throw new HttpError(400, 'bad_request', '"approved" (boolean) is required');
      const via = body.via === 'cli' || body.via === 'telegram' ? body.via : 'api';
      return send(
        res,
        200,
        await this.deps.inbox.answer(inboxId, {
          approved: body.approved,
          note: typeof body.note === 'string' ? body.note : undefined,
          via,
        }),
      );
    }
    if (path === '/schedules' || path.startsWith('/schedules/'))
      return this.schedules(req, res, method, path);
    if (method === 'POST' && path === '/shutdown') {
      const body = asRecord(await readBody(req));
      send(res, 200, { ok: true });
      this.deps.onShutdown({ force: body.force === true });
      return;
    }
    throw new HttpError(404, 'not_found', `no route for ${method} ${path}`);
  }

  private async schedules(
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    path: string,
  ): Promise<void> {
    const api = this.deps.schedules();
    if (!api) throw new HttpError(404, 'not_found', 'schedules are not available');
    if (method === 'GET' && path === '/schedules') return send(res, 200, api.list());
    if (method === 'POST' && path === '/schedules') {
      const body = asRecord(await readBody(req));
      for (const k of ['cron', 'orgRoot', 'project', 'workflow'])
        if (typeof body[k] !== 'string')
          throw new HttpError(400, 'bad_request', `"${k}" is required`);
      return send(
        res,
        200,
        api.add({
          cron: body.cron as string,
          orgRoot: body.orgRoot as string,
          project: body.project as string,
          workflow: body.workflow as string,
          input: typeof body.input === 'string' ? body.input : '',
          adapter: typeof body.adapter === 'string' ? body.adapter : undefined,
          budgetUsd: typeof body.budgetUsd === 'number' ? body.budgetUsd : undefined,
          enabled: body.enabled !== false,
        }),
      );
    }
    const run = /^\/schedules\/([^/]+)\/run$/.exec(path);
    if (run && method === 'POST')
      return send(res, 200, await api.runNow(decodeURIComponent(run[1] as string)));
    const one = /^\/schedules\/([^/]+)$/.exec(path);
    if (one && method === 'DELETE') {
      api.remove(decodeURIComponent(one[1] as string));
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found', `no route for ${method} ${path}`);
  }

  /** History first (run events since `since`, then the runtime buffer), then live until the run ends. */
  private async stream(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    url: URL,
  ): Promise<void> {
    const events = await this.deps.store.read(runId);
    if (events.length === 0) throw new HttpError(404, 'not_found', `run ${runId} not found`);
    const header = req.headers['last-event-id'];
    const since =
      Number(url.searchParams.get('since') ?? (typeof header === 'string' ? header : 0)) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let closed = false;
    const write = (env: Envelope) => {
      if (closed) return;
      res.write(`id: ${env.seq}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`);
    };
    const end = (status: RunStatus) => {
      write({ kind: 'end', seq: RUNTIME_SEQ_BASE * 2, status });
      finish();
    };
    let offStore = () => {};
    let offRuntime = () => {};
    const finish = () => {
      if (closed) return;
      closed = true;
      offStore();
      offRuntime();
      res.end();
    };
    req.on('close', finish);

    // subscribe before replaying history so nothing between the read and the subscription is lost
    const pendingLive: Envelope[] = [];
    let replaying = true;
    const endIfTerminal = () => {
      void this.deps.runs.state(runId).then(
        (st) => {
          if (isTerminal(st.status)) end(st.status);
        },
        () => undefined,
      );
    };
    offStore = this.deps.store.subscribe((e) => {
      if (e.runId !== runId) return;
      const env: Envelope = { kind: 'run', seq: e.seq, event: e };
      if (replaying) pendingLive.push(env);
      else {
        write(env);
        endIfTerminal();
      }
    });
    offRuntime = this.deps.runs.onRuntimeEvent((e) => {
      if (e.runId !== runId) return;
      const env: Envelope = {
        kind: 'runtime',
        seq: RUNTIME_SEQ_BASE + e.seq,
        event: trimRuntime(e),
      };
      if (replaying) pendingLive.push(env);
      else write(env);
    });
    const runSince = since >= RUNTIME_SEQ_BASE ? Number.POSITIVE_INFINITY : since;
    const runtimeSince = since >= RUNTIME_SEQ_BASE ? since - RUNTIME_SEQ_BASE : 0;
    let last = 0;
    for (const e of events) {
      last = e.seq;
      if (e.seq > runSince) write({ kind: 'run', seq: e.seq, event: e });
    }
    for (const e of this.deps.runs.runtimeEvents(runId, runtimeSince))
      write({ kind: 'runtime', seq: RUNTIME_SEQ_BASE + e.seq, event: trimRuntime(e) });
    replaying = false;
    for (const env of pendingLive) if (env.kind !== 'run' || env.seq > last) write(env);
    if (url.searchParams.get('history') === '1') {
      // replay: the history and the current status, never waiting for the run to end
      const st = await this.deps.runs.state(runId);
      end(st.status);
      return;
    }
    endIfTerminal();
  }
}
