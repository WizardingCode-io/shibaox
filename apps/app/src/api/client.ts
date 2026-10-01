import type { ProjectProfile, RunState } from '@wizardingcode/shibaox-core';
import type {
  AuditDoc,
  ConnectorTemplate,
  DecisionsView,
  Envelope,
  Health,
  HiggsfieldView,
  InboxItem,
  KeyRow,
  McpAddRequest,
  McpServerRow,
  McpTestResult,
  OrgConfig,
  OrgConfigPatch,
  OrgInfo,
  PluginRow,
  ProjectEntry,
  RolePatch,
  RoleRow,
  RoutineDraft,
  RoutineInput,
  RoutinePatch,
  RoutineRow,
  RoutineView,
  RunFile,
  RunFileContent,
  RunSummaryPlus,
  SkillAddRequest,
  SkillDiscovery,
  SkillRow,
  SkillSource,
  SubmitRequest,
} from '@wizardingcode/shibaox-daemon';
import type { ModelChoice } from '@wizardingcode/shibaox-providers';
import type {
  AddSkillOutcome,
  HiggsfieldMode,
  McpRow,
  SkillDoc,
} from '../screens/customize/types.js';

/** An error the daemon answered with (status, its code and message). */
export class AppHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Extra fields of the error body (a 409 of `DELETE /skills/:id` names the `roles`). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppHttpError';
  }
}

/**
 * The daemon's API from the browser: JSON over `fetch` with the bearer token, and the run
 * event stream (SSE) read through `fetch` too, since `EventSource` cannot send a header.
 */
export type { RoutineDraft, RoutinePatch, RoutineView, RunFile, RunFileContent };

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
      const { error: err, ...details } =
        (parsed as { error?: { code?: string; message?: string } } | undefined) ?? {};
      throw new AppHttpError(
        r.status,
        err?.code ?? 'error',
        err?.message ?? `HTTP ${r.status}`,
        Object.keys(details).length ? details : undefined,
      );
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
  /** The files a run created or changed (its diff plus what it reported). */
  /** The Higgsfield status: the CLI, the account, the MCP. */
  higgsfield(): Promise<HiggsfieldView> {
    return this.json('GET', '/integrations/higgsfield');
  }
  higgsfieldLogin(): Promise<{ started: boolean }> {
    return this.json('POST', '/integrations/higgsfield/login');
  }
  /** What Higgsfield generates with: `auto` (the API when a key is saved), the account or the API. */
  setHiggsfieldMode(mode: HiggsfieldMode): Promise<HiggsfieldView> {
    return this.json('PUT', '/integrations/higgsfield', { mode });
  }
  /** Who decides and the latest decisions across runs. */
  decisions(): Promise<DecisionsView> {
    return this.json('GET', '/decisions');
  }
  files(id: string): Promise<{ root: string; files: RunFile[] }> {
    return this.json('GET', `/runs/${encodeURIComponent(id)}/files`);
  }
  /** One file of the run's workspace: text, or base64 for binaries; 403 outside it. */
  fileContent(id: string, path: string): Promise<RunFileContent> {
    return this.json(
      'GET',
      `/runs/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`,
    );
  }
  /** Writes a text file into the run's workspace ("Save to project"). */
  writeFile(id: string, path: string, content: string): Promise<{ path: string; size: number }> {
    return this.json(
      'PUT',
      `/runs/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}`,
      { content },
    );
  }
  /** The file as a Blob for a download (the token travels in the header, never in a URL). */
  async fileBlob(id: string, path: string): Promise<Blob> {
    const r = await this.fetchImpl(
      `${this.base}/runs/${encodeURIComponent(id)}/files/content?path=${encodeURIComponent(path)}&download=1`,
      { method: 'GET', headers: this.headers() },
    );
    if (r.status >= 400) {
      let err: { code?: string; message?: string } | undefined;
      try {
        err = ((await r.json()) as { error?: { code?: string; message?: string } }).error;
      } catch {
        err = undefined;
      }
      throw new AppHttpError(r.status, err?.code ?? 'error', err?.message ?? `HTTP ${r.status}`);
    }
    return r.blob();
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
  models(): Promise<ModelChoice[]> {
    return this.json('GET', '/models');
  }
  routines(): Promise<RoutineView[]> {
    return this.json('GET', '/routines');
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
  removeRoutine(id: string): Promise<void> {
    return this.json('DELETE', `/routines/${encodeURIComponent(id)}`);
  }
  addRoutine(r: RoutineInput): Promise<RoutineRow> {
    return this.json('POST', '/routines', r);
  }
  updateRoutine(id: string, patch: RoutinePatch): Promise<RoutineRow> {
    return this.json('PUT', `/routines/${encodeURIComponent(id)}`, patch);
  }
  /** A sentence into a routine draft (the daemon's cheap model); nothing is saved. */
  draftRoutine(r: { text: string; orgRoot: string; project?: string }): Promise<RoutineDraft> {
    return this.json('POST', '/routines/draft', r);
  }
  syncRoutines(orgRoot: string): Promise<unknown> {
    return this.json('POST', '/routines/sync', { orgRoot });
  }
  keys(): Promise<KeyRow[]> {
    return this.json('GET', '/keys');
  }
  setKey(name: string, value: string): Promise<{ name: string; set: true }> {
    return this.json('PUT', `/keys/${encodeURIComponent(name)}`, { value });
  }
  unsetKey(name: string): Promise<{ name: string; removed: boolean }> {
    return this.json('DELETE', `/keys/${encodeURIComponent(name)}`);
  }
  orgConfig(root: string): Promise<OrgConfig> {
    return this.json('GET', `/orgs/config?org=${encodeURIComponent(root)}`);
  }
  setOrgConfig(root: string, patch: OrgConfigPatch): Promise<OrgConfig> {
    return this.json('PUT', `/orgs/config?org=${encodeURIComponent(root)}`, patch);
  }
  mcpList(org: string): Promise<McpRow[]> {
    return this.json('GET', `/mcp?org=${encodeURIComponent(org)}`);
  }
  mcpTest(id: string, org: string): Promise<McpTestResult> {
    return this.json('POST', `/mcp/${encodeURIComponent(id)}/test?org=${encodeURIComponent(org)}`);
  }
  // ---- Customize: skills, roles, connectors, registries, plugins

  /** The org's skills (`org/skills/<id>/SKILL.md`) with the roles that use each. */
  skills(org: string): Promise<SkillRow[]> {
    return this.json('GET', `/skills?org=${encodeURIComponent(org)}`);
  }
  /** One skill with its SKILL.md. */
  skill(org: string, id: string): Promise<SkillDoc> {
    return this.json('GET', `/skills/${encodeURIComponent(id)}?org=${encodeURIComponent(org)}`);
  }
  /** Installs skills from a repository or a folder, or writes one. */
  addSkill(org: string, req: SkillAddRequest): Promise<AddSkillOutcome> {
    return this.json('POST', `/skills?org=${encodeURIComponent(org)}`, req);
  }
  /** What a repository offers (a cached shallow clone on the daemon). */
  discoverSkills(repo: string, path?: string): Promise<SkillDiscovery> {
    const p = new URLSearchParams({ repo });
    if (path) p.set('path', path);
    return this.json('GET', `/skills/discover?${p.toString()}`);
  }
  /** Removes a skill; `detach` first takes it out of the roles that list it (else 409 while used). */
  removeSkill(org: string, id: string, detach: boolean): Promise<{ removed: true }> {
    return this.json(
      'DELETE',
      `/skills/${encodeURIComponent(id)}?org=${encodeURIComponent(org)}${detach ? '&detach=1' : ''}`,
    );
  }
  roles(org: string): Promise<RoleRow[]> {
    return this.json('GET', `/roles?org=${encodeURIComponent(org)}`);
  }
  /** Replaces a role's `mcp:` and/or `skills:` lists. */
  setRoleLinks(org: string, id: string, links: RolePatch): Promise<RoleRow> {
    return this.json(
      'PUT',
      `/roles/${encodeURIComponent(id)}?org=${encodeURIComponent(org)}`,
      links,
    );
  }
  /** Writes `catalog/<id>.yaml` for an MCP server and attaches it to the roles. */
  addMcp(org: string, req: McpAddRequest): Promise<McpServerRow> {
    return this.json('POST', `/mcp?org=${encodeURIComponent(org)}`, req);
  }
  /** Removes a connector after detaching it from every role. */
  removeMcp(org: string, id: string): Promise<{ removed: true }> {
    return this.json('DELETE', `/mcp/${encodeURIComponent(id)}?org=${encodeURIComponent(org)}`);
  }
  registryConnectors(): Promise<ConnectorTemplate[]> {
    return this.json('GET', '/registry/connectors');
  }
  registrySkills(): Promise<SkillSource[]> {
    return this.json('GET', '/registry/skills');
  }
  /** The partner integrations and how far each is set up. */
  plugins(): Promise<PluginRow[]> {
    return this.json('GET', '/plugins');
  }

  projectProfile(path: string, org?: string): Promise<ProjectProfile> {
    const p = new URLSearchParams({ path });
    if (org) p.set('org', org);
    return this.json('GET', `/projects/profile?${p.toString()}`);
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
