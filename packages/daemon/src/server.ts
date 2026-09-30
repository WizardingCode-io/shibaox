import { timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import {
  type EventStore,
  isTerminal,
  type ProjectProfile,
  type RunStatus,
  type StoredEvent,
} from '@wizardingcode/shibaox-core';
import type { ScheduleRow } from '@wizardingcode/shibaox-persistence-sqlite';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import { AlreadyResolvedError, type InboxService, NotFoundError } from './inbox.js';
import { type OrgConfigPatch, orgInfo, readOrgConfig, writeOrgConfig } from './org-config.js';
import type { RunManager, SubmitRequest } from './run-manager.js';
import type { RuntimeEnvelope } from './runtime-buffer.js';
import type { KeyRow } from './secrets.js';

export interface Health {
  version: string;
  /** The daemon process (a `daemon stop` tells a restarted daemon from the one it stopped). */
  pid?: number;
  uptimeSeconds: number;
  runs: { running: number; queued: number; waiting: number };
  channels: string[];
}

/**
 * One SSE frame: a persisted run event (`seq` = its 1-based index in the run), a runtime
 * event (`seq` = its per-run runtime sequence), or the end of a terminal run. `cursor`
 * (`<runIdx>:<runtimeSeq>`) is the position after the frame: pass it as `since` to resume.
 */
export type Envelope =
  | { kind: 'run'; seq: number; cursor: string; event: StoredEvent }
  | { kind: 'runtime'; seq: number; cursor: string; event: RuntimeEnvelope }
  | { kind: 'end'; seq: number; cursor: string; status: RunStatus };

/** Parses a cursor (`<runIdx>:<runtimeSeq>`, or a bare run index); anything else is the start. */
export function parseCursor(raw: string | undefined | null): { run: number; runtime: number } {
  if (!raw) return { run: 0, runtime: 0 };
  const [a, b] = raw.split(':');
  const run = Number(a) || 0;
  const runtime = Number(b) || 0;
  return { run: Math.max(0, run), runtime: Math.max(0, runtime) };
}

export interface SchedulesApi {
  list(): ScheduleRow[];
  add(s: Omit<ScheduleRow, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): ScheduleRow;
  remove(id: string): void;
  runNow(id: string): Promise<{ runId: string }>;
}

/** A project a dashboard may pick: configured in daemon.yaml, seen in a recent run, or the home workspace. */
export interface ProjectEntry {
  path: string;
  source: 'config' | 'recent' | 'workspace';
}

export interface ServerDeps {
  store: EventStore;
  runs: RunManager;
  inbox: InboxService;
  schedules: () => SchedulesApi | undefined;
  health: () => Health;
  /** The profile of a project directory (with the org's vault note when `orgRoot` is given). */
  profile: (path: string, orgRoot?: string) => ProjectProfile;
  /** The models of the catalog and the local servers, and whether this daemon can use them. */
  models: () => Promise<ModelChoice[]>;
  /** The org under the shibaox home, created on first use. */
  defaultOrg: () => Promise<{ root: string; created: boolean }>;
  /** Where runs may work: `daemon.yaml projects`, recent runs, the home workspace. */
  projects: () => Promise<ProjectEntry[]>;
  /** The key vault, masked; set/unset take effect at once. */
  keys: () => KeyRow[];
  setKey: (name: string, value: string) => void;
  unsetKey: (name: string) => boolean;
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
/** The network listener: where, with which token, and TLS files when any. */
export interface ListenOptions {
  host: string;
  port: number;
  token: string;
  tls?: { cert: string; key: string };
}

const bearerOk = (header: string | undefined, token: string): boolean => {
  const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};

export class DaemonServer {
  private server: Server | undefined;
  private remote: Server | undefined;
  private readonly sockets = new Set<import('node:net').Socket>();

  /** Network listener, set before `listen()`; undefined keeps the daemon socket-only. */
  listenOn: ListenOptions | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly deps: ServerDeps,
    listenOn?: ListenOptions,
  ) {
    this.listenOn = listenOn;
  }

  /** Where the network listener answers, once listening. */
  address(): { host: string; port: number; tls: boolean } | undefined {
    const a = this.remote?.address() as AddressInfo | null | undefined;
    if (!a || !this.listenOn) return undefined;
    return { host: a.address, port: a.port, tls: !!this.listenOn.tls };
  }

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
    if (this.listenOn) await this.listenRemote(this.listenOn);
  }

  /**
   * The same API on a TCP port. Every request must carry `Authorization: Bearer <token>`
   * (compared in constant time); the one exception is `GET /health` without any token, which
   * answers the version only, so a monitor can watch the daemon without the token.
   */
  private async listenRemote(on: ListenOptions): Promise<void> {
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      if (!bearerOk(req.headers.authorization, on.token)) {
        // no token at all: a monitor may still read the version; a wrong one is told so at once
        const anonymous = req.headers.authorization === undefined;
        if (anonymous && req.method === 'GET' && (req.url ?? '/').split('?')[0] === '/health')
          return send(res, 200, { version: this.deps.health().version });
        return send(res, 401, {
          error: {
            code: 'unauthorized',
            message: anonymous
              ? 'a bearer token is required (SHIBAOX_DAEMON_TOKEN)'
              : 'the bearer token is wrong (SHIBAOX_DAEMON_TOKEN)',
          },
        });
      }
      this.handle(req, res).catch((e: unknown) => {
        const h = toHttp(e);
        if (!res.headersSent) send(res, h.status, { error: { code: h.code, message: h.message } });
        else res.end();
      });
    };
    const server = on.tls
      ? createTlsServer({ cert: readFileSync(on.tls.cert), key: readFileSync(on.tls.key) }, handler)
      : createServer(handler);
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(on.port, on.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.remote = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    const remote = this.remote;
    this.server = undefined;
    this.remote = undefined;
    if (!server && !remote) return;
    for (const s of this.sockets) s.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (remote) await new Promise<void>((resolve) => remote.close(() => resolve()));
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
    if (method === 'GET' && path === '/models') return send(res, 200, await this.deps.models());
    if (path === '/orgs/config' && (method === 'GET' || method === 'PUT')) {
      const org = url.searchParams.get('org') ?? '';
      if (!org) throw new HttpError(400, 'bad_request', '"org" is required');
      try {
        if (method === 'GET') return send(res, 200, readOrgConfig(org));
        const body = asRecord(await readBody(req));
        return send(res, 200, writeOrgConfig(org, body as OrgConfigPatch));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        throw new HttpError(/not found/i.test(m) ? 404 : 400, 'bad_request', m);
      }
    }
    if (method === 'GET' && path === '/orgs/default')
      return send(res, 200, await this.deps.defaultOrg());
    if (method === 'GET' && path === '/orgs/info') {
      const org = url.searchParams.get('org') ?? '';
      if (!org) throw new HttpError(400, 'bad_request', '"org" is required');
      try {
        return send(res, 200, orgInfo(org));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        throw new HttpError(/not found/i.test(m) ? 404 : 400, 'bad_request', m);
      }
    }
    if (method === 'GET' && path === '/projects') return send(res, 200, await this.deps.projects());
    if (method === 'GET' && path === '/keys') return send(res, 200, this.deps.keys());
    const keyName = param(/^\/keys\/([^/]+)$/);
    if (keyName !== undefined && method === 'PUT') {
      const body = asRecord(await readBody(req));
      if (typeof body.value !== 'string')
        throw new HttpError(400, 'bad_request', '"value" is required');
      try {
        this.deps.setKey(keyName, body.value);
      } catch (e) {
        throw new HttpError(400, 'bad_request', e instanceof Error ? e.message : String(e));
      }
      return send(res, 200, { name: keyName, set: true });
    }
    if (keyName !== undefined && method === 'DELETE')
      return send(res, 200, { name: keyName, removed: this.deps.unsetKey(keyName) });
    if (method === 'GET' && path === '/projects/profile') {
      const p = url.searchParams.get('path') ?? '';
      if (!p) throw new HttpError(400, 'bad_request', '"path" is required');
      const org = url.searchParams.get('org') ?? undefined;
      try {
        return send(res, 200, this.deps.profile(p, org));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/not found/.test(m)) throw new HttpError(404, 'not_found', m);
        throw e;
      }
    }
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
    const runDiff = param(/^\/runs\/([^/]+)\/diff$/);
    if (runDiff !== undefined && method === 'GET') {
      const d = await this.deps.runs.diff(runDiff);
      if (!d) throw new HttpError(404, 'no_workspace', 'The run workspace is gone');
      return send(res, 200, d);
    }
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

  /** History first (run events after the cursor, then the runtime buffer), then live until the run ends. */
  private async stream(
    req: IncomingMessage,
    res: ServerResponse,
    runId: string,
    url: URL,
  ): Promise<void> {
    const header = req.headers['last-event-id'];
    const since = parseCursor(
      url.searchParams.get('since') ?? (typeof header === 'string' ? header : undefined),
    );
    let runIdx = 0;
    let runtimeSeq = 0;
    let closed = false;
    let replaying = true;
    const pendingLive: (() => void)[] = [];
    const cursor = () => `${runIdx}:${runtimeSeq}`;
    const emit = (env: Envelope) => {
      if (closed) return;
      res.write(`id: ${env.cursor}\nevent: ${env.kind}\ndata: ${JSON.stringify(env)}\n\n`);
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
    const end = (status: RunStatus) => {
      emit({ kind: 'end', seq: 0, cursor: cursor(), status });
      finish();
    };
    const endIfTerminal = () => {
      void this.deps.runs.state(runId).then(
        (st) => {
          if (isTerminal(st.status)) end(st.status);
        },
        () => undefined,
      );
    };
    const writeRun = (e: StoredEvent) => {
      runIdx++;
      if (runIdx > since.run) emit({ kind: 'run', seq: runIdx, cursor: cursor(), event: e });
    };
    const writeRuntime = (e: RuntimeEnvelope) => {
      runtimeSeq = e.seq;
      if (e.seq > since.runtime)
        emit({ kind: 'runtime', seq: e.seq, cursor: cursor(), event: trimRuntime(e) });
    };
    // subscribe before reading history so nothing appended in between is lost; live frames
    // wait until the history is out (duplicates are dropped by seq)
    let lastSeqSeen = 0;
    offStore = this.deps.store.subscribe((e) => {
      if (e.runId !== runId) return;
      const deliver = () => {
        if (e.seq <= lastSeqSeen) return;
        lastSeqSeen = e.seq;
        writeRun(e);
        endIfTerminal();
      };
      if (replaying) pendingLive.push(deliver);
      else deliver();
    });
    offRuntime = this.deps.runs.onRuntimeEvent((e) => {
      if (e.runId !== runId) return;
      const deliver = () => {
        if (e.seq <= runtimeSeq) return;
        writeRuntime(e);
      };
      if (replaying) pendingLive.push(deliver);
      else deliver();
    });
    const events = await this.deps.store.read(runId);
    if (events.length === 0) {
      offStore();
      offRuntime();
      throw new HttpError(404, 'not_found', `run ${runId} not found`);
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    req.on('close', finish);
    for (const e of events) {
      lastSeqSeen = e.seq;
      writeRun(e);
    }
    for (const e of this.deps.runs.runtimeEvents(runId)) writeRuntime(e);
    replaying = false;
    for (const deliver of pendingLive) deliver();
    if (url.searchParams.get('history') === '1') {
      // replay: the history and the current status, never waiting for the run to end
      const st = await this.deps.runs.state(runId);
      end(st.status);
      return;
    }
    endIfTerminal();
  }
}
