import { type ClientRequest, request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProjectProfile, RunState } from '@wizardingcode/shibaox-core';
import type { RoutineRow, ScheduleRow } from '@wizardingcode/shibaox-persistence-sqlite';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import type { InboxItem } from './inbox.js';
import type { McpServerRow, McpTestResult } from './mcp.js';
import type { OrgConfig, OrgConfigPatch, OrgInfo } from './org-config.js';
import type { RoutineInput } from './routines.js';
import type { RunSummaryPlus, SubmitRequest } from './run-manager.js';
import type { AuditDoc } from './runs/audit.js';
import type { DiffResult } from './runs/diff.js';
import type { RunFile, RunFileContent } from './runs/files.js';
import type { KeyRow } from './secrets.js';
import type { Envelope, Health, ProjectEntry } from './server.js';

export type { Envelope, Health, ProjectEntry } from './server.js';

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

/** Where a client talks to: the local Unix socket, or a remote listener with its token. */
export type DaemonTarget = string | { baseUrl: string; token?: string };

/** A thin client for the daemon's API over its Unix socket, or over TCP with a bearer token. */
export class DaemonClient {
  /** The socket path, or the remote base URL (what errors name). */
  readonly socketPath: string;
  private readonly remote: { url: URL; token?: string } | undefined;

  constructor(target: DaemonTarget) {
    if (typeof target === 'string') this.socketPath = target;
    else {
      const url = new URL(target.baseUrl);
      this.remote = { url, token: target.token };
      this.socketPath = url.origin;
    }
  }

  /** Whether this client reaches a daemon on another machine. */
  get isRemote(): boolean {
    return this.remote !== undefined;
  }

  /** Node request options for `path`: the socket, or the remote host with the bearer. */
  private options(path: string, method: string, headers: Record<string, string> = {}) {
    if (!this.remote) return { socketPath: this.socketPath, path, method, headers };
    const { url, token } = this.remote;
    return {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname.replace(/\/$/, '')}${path}`,
      method,
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    };
  }

  private request(
    options: ReturnType<DaemonClient['options']>,
    cb: (res: IncomingMessage) => void,
  ): ClientRequest {
    return options.protocol === 'https:' ? httpsRequest(options, cb) : httpRequest(options, cb);
  }

  private call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = this.request(
        this.options(path, method, {
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...headers,
        }),
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
          res.on('error', (e) => reject(new DaemonUnavailableError(this.socketPath, e)));
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
  listRuns(
    q: { status?: string; org?: string; parent?: string; thread?: string } = {},
  ): Promise<RunSummaryPlus[]> {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.org) p.set('org', q.org);
    if (q.parent) p.set('parent', q.parent);
    if (q.thread) p.set('thread', q.thread);
    const qs = p.toString();
    return this.json('GET', `/runs${qs ? `?${qs}` : ''}`);
  }
  /** Everything that happened in a run: nodes, tool calls, gates, decisions, approvals, git, cost. */
  audit(id: string): Promise<AuditDoc> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}/audit`);
  }
  /** The same, as a Markdown document. */
  async auditMarkdown(id: string): Promise<string> {
    const r = await this.call('GET', `/runs/${encodeURIComponent(id)}/audit?format=md`);
    if (r.status >= 400) {
      const err = (r.body as { error?: { code?: string; message?: string } } | undefined)?.error;
      throw new DaemonHttpError(r.status, err?.code ?? 'error', err?.message ?? `HTTP ${r.status}`);
    }
    return String(r.body ?? '');
  }
  /** Removes finished runs whose last event is older than `before` (ISO date). */
  pruneRuns(before: string): Promise<{ removed: string[] }> {
    return this.json('POST', '/runs/prune', { before });
  }
  getRun(id: string): Promise<RunState> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}`);
  }
  /** Tiers, judge, adapter and budget of an org (`models.yaml` / `org.yaml`). */
  orgConfig(root: string): Promise<OrgConfig> {
    return this.json('GET', `/orgs/config?org=${encodeURIComponent(root)}`);
  }
  setOrgConfig(root: string, patch: OrgConfigPatch): Promise<OrgConfig> {
    return this.json('PUT', `/orgs/config?org=${encodeURIComponent(root)}`, patch);
  }
  /** The org's workflows and runtime hints (404 when `root` is not an org). */
  orgInfo(root: string): Promise<OrgInfo> {
    return this.json('GET', `/orgs/info?org=${encodeURIComponent(root)}`);
  }
  /** The org's catalog MCP servers: who uses them, which keys they miss. */
  mcpList(org: string): Promise<McpServerRow[]> {
    return this.json('GET', `/mcp?org=${encodeURIComponent(org)}`);
  }
  /** Starts one catalog server on the daemon and lists its tools. */
  mcpTest(id: string, org: string): Promise<McpTestResult> {
    return this.json('POST', `/mcp/${encodeURIComponent(id)}/test?org=${encodeURIComponent(org)}`);
  }
  /** Projects a dashboard may pick, the daemon's home workspace last. */
  projects(): Promise<ProjectEntry[]> {
    return this.json('GET', '/projects');
  }
  /** The org under the shibaox home (`~/.shibaox/org`), created on first use. */
  defaultOrg(): Promise<{ root: string; created: boolean }> {
    return this.json('GET', '/orgs/default');
  }
  /** The key vault, masked. */
  keys(): Promise<KeyRow[]> {
    return this.json('GET', '/keys');
  }
  setKey(name: string, value: string): Promise<{ name: string; set: true }> {
    return this.json('PUT', `/keys/${encodeURIComponent(name)}`, { value });
  }
  unsetKey(name: string): Promise<{ name: string; removed: boolean }> {
    return this.json('DELETE', `/keys/${encodeURIComponent(name)}`);
  }
  /** The models a run can be pointed at (`/model`), with whether the daemon can use them. */
  models(): Promise<ModelChoice[]> {
    return this.json('GET', '/models');
  }
  /** What a project directory is (stack, tests, size); 404 when the path does not exist. */
  projectProfile(path: string, orgRoot?: string): Promise<ProjectProfile> {
    const p = new URLSearchParams({ path });
    if (orgRoot) p.set('org', orgRoot);
    return this.json('GET', `/projects/profile?${p.toString()}`);
  }
  /** The files a run touched (its diff plus what it reported), with sizes. */
  files(id: string): Promise<{ root: string; files: RunFile[] }> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}/files`);
  }
  /** One file of the run's workspace; 403 outside it, 404 when missing. */
  fileContent(id: string, path: string): Promise<RunFileContent> {
    return this.json(
      'GET',
      `/runs/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`,
    );
  }
  /** A raw GET (headers and text body) for downloads and the like. */
  fetchRaw(
    path: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = this.request(this.options(path, 'GET'), (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (typeof v === 'string') headers[k] = v;
          resolve({
            status: res.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (e) => reject(new DaemonUnavailableError(this.socketPath, e)));
      });
      req.on('error', (e) => reject(new DaemonUnavailableError(this.socketPath, e)));
      req.end();
    });
  }
  /** The run's checkout diff against HEAD (404 `no_workspace` once the directory is gone). */
  diff(id: string): Promise<DiffResult> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}/diff`);
  }
  /** Redirects the running task of a run: it stops and starts again with the note. */
  steer(
    id: string,
    o: { nodeId?: string; note: string; via?: 'cli' | 'api' | 'telegram' },
  ): Promise<RunState> {
    return this.json('POST', `/runs/${encodeURIComponent(id)}/steer`, o);
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
  routines(): Promise<RoutineRow[]> {
    return this.json('GET', '/routines');
  }
  routine(id: string): Promise<RoutineRow> {
    return this.json('GET', `/routines/${encodeURIComponent(id)}`);
  }
  addRoutine(r: RoutineInput): Promise<RoutineRow> {
    return this.json('POST', '/routines', r);
  }
  removeRoutine(id: string): Promise<void> {
    return this.json('DELETE', `/routines/${encodeURIComponent(id)}`);
  }
  runRoutine(id: string): Promise<{ runId: string }> {
    return this.json('POST', `/routines/${encodeURIComponent(id)}/run`);
  }
  pauseRoutine(id: string): Promise<RoutineRow> {
    return this.json('POST', `/routines/${encodeURIComponent(id)}/pause`);
  }
  resumeRoutine(id: string): Promise<RoutineRow> {
    return this.json('POST', `/routines/${encodeURIComponent(id)}/resume`);
  }
  /** Loads `org/routines/*.yaml` of an org into the daemon. */
  syncRoutines(
    orgRoot: string,
  ): Promise<{ added: string[]; updated: string[]; removed: string[] }> {
    return this.json('POST', '/routines/sync', { orgRoot });
  }
  shutdown(o: { force?: boolean } = {}): Promise<void> {
    return this.json('POST', '/shutdown', o);
  }

  /** SSE frames of a run, after `since` (a frame `cursor`), until the run ends or `signal` aborts. */
  async *events(
    id: string,
    o: { since?: string; signal?: AbortSignal; historyOnly?: boolean } = {},
  ): AsyncIterable<Envelope> {
    const q = new URLSearchParams();
    if (o.since) q.set('since', o.since);
    if (o.historyOnly) q.set('history', '1');
    const qs = q.toString();
    const path = `/runs/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ''}`;
    const frames: Envelope[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const req = this.request(this.options(path, 'GET'), (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          let body: { error?: { code?: string; message?: string } } = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as typeof body;
          } catch {
            // a non-JSON error body: keep the status only
          }
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
