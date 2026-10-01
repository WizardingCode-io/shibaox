import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueryFn } from '@wizardingcode/shibaox-adapter-claude-code';
import { resolveAppDist } from '@wizardingcode/shibaox-bridge';
import { type EventStore, type MockScript, runArgv } from '@wizardingcode/shibaox-core';
import type { Graphify } from '@wizardingcode/shibaox-memory';
import {
  OutboxRepo,
  RoutinesRepo,
  RuntimeEventsRepo,
  SqliteEventStore,
} from '@wizardingcode/shibaox-persistence-sqlite';
import {
  discoverModels,
  type ModelChoice,
  type ProviderEntry,
} from '@wizardingcode/shibaox-providers';
import { type ChatMessage, loadOrg, type Org } from '@wizardingcode/shibaox-schemas';
import { githubChannel } from './channels/github.js';
import { macosChannel } from './channels/macos.js';
import { OutboxWorker } from './channels/outbox.js';
import { inboxToken, telegramChannel } from './channels/telegram.js';
import type { Channel } from './channels/types.js';
import { type DaemonConfig, HIGGSFIELD_SIGNUP_URL, loadDaemonConfig } from './config.js';
import { ensureDefaultOrg } from './default-org.js';
import {
  defaultHiggsfieldProbe,
  HIGGSFIELD_INSTALL,
  type HiggsfieldProbe,
  type HiggsfieldView,
  higgsfieldStatus,
  type LoginStart,
} from './higgsfield.js';
import { type HomePaths, homePaths } from './home.js';
import { type InboxId, InboxService } from './inbox.js';
import { mcpAdd, mcpList, mcpRemove, mcpTest } from './mcp.js';
import { pluginsStatus, whichOnPath } from './plugins.js';
import { connectorRegistry } from './registry/connectors.js';
import { skillSources } from './registry/skills.js';
import { listRoles, putRole } from './roles.js';
import { Routines } from './routines.js';
import { RunManager } from './run-manager.js';
import { vaultDir } from './runs/notes.js';
import { profileFor } from './runs/profile.js';
import { buildRunReport } from './runs/report.js';
import { draftPrompt, parseDraft, routineDraftWriter } from './runs/routine-draft.js';
import { orgSummarizer } from './runs/summarize.js';
import {
  commandEnv,
  type DeciderInfo,
  type DecisionRow,
  type DecisionsView,
  deciderInfo,
  registryFor,
} from './runtime.js';
import { SecretsStore } from './secrets.js';
import {
  DaemonServer,
  type Health,
  HttpError,
  type ListenOptions,
  type ProjectEntry,
  type SchedulesApi,
  type ServerDeps,
} from './server.js';
import { SkillsService } from './skills.js';

export interface DaemonOptions {
  home?: HomePaths;
  config?: DaemonConfig;
  /** The browser app's dist to serve under /app: a path, `null` for none (tests), else resolved from the installed package. */
  appDist?: string | null;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Injected store (tests); by default the SQLite file under the home directory. */
  store?: EventStore;
  queryFn?: QueryFn;
  graphify?: Graphify;
  extraProviders?: ProviderEntry[];
  /** Injected channels (tests); by default built from `daemon.yaml` and the platform. */
  channels?: Channel[];
  now?: () => string;
  version?: string;
  vault?: string;
  mockScript?: MockScript;
  /** Routines; by default over the SQLite store (none with an injected memory store). */
  schedules?: (d: Daemon) => SchedulesApi & { start(): void; stop(): void };
  /** Whether the `claude` CLI is installed (tests inject it; probed with `which` by default). */
  claudeInstalled?: boolean;
  /** Model discovery at start and before runs (default on; tests turn it off: it probes local servers). */
  discovery?: boolean;
  /** The Bot API base for the Telegram channel the daemon builds itself (tests point it at a fake). */
  telegramApiBase?: string;
  /** Conversation summariser (tests inject one); by default the org's cheap tier or the run's model. */
  summarize?: (transcript: string, org: Org) => Promise<string>;
  /** How Higgsfield (CLI + MCP) is probed (tests inject fakes). */
  higgsfield?: HiggsfieldProbe;
  /** Whether a network peer address is this machine (default: loopback; tests pretend otherwise). */
  localPeer?: (remoteAddress: string | undefined) => boolean;
  /** "Create with Shibaox" writer (tests inject one): the model's answer for a draft prompt; by default the org's cheap tier. */
  routineDraft?: (prompt: string, org: Org) => Promise<string>;
  /** Tokens a conversation may carry before it is compacted (tests lower it). */
  conversationTokens?: number;
  /** Interval of the SSE heartbeat comment (default 20 s; tests shorten it). */
  heartbeatMs?: number;
}

/** Turns kept per Telegram chat for the orchestrator's conversation. */
const THREAD_TURNS = 20;

/** The last `max` messages of a thread; a leading summary (older turns condensed) always stays. */
export function keepThread(t: readonly ChatMessage[], max: number): ChatMessage[] {
  if (t.length <= max) return [...t];
  return t[0]?.summary ? [t[0], ...t.slice(-(max - 1))] : t.slice(-max);
}

/** The local daemon: store, inbox, run manager, channels and the socket API, composed. */
export class Daemon {
  readonly paths: HomePaths;
  readonly config: DaemonConfig;
  readonly store: EventStore;
  readonly inbox: InboxService;
  readonly runs: RunManager;
  readonly channels: Channel[];
  readonly version: string;
  /** The key vault; its values sit on top of the environment the daemon was started with. */
  readonly secrets: SecretsStore;
  /** The org skills: install, discover (cached per process), remove. */
  private readonly skills: SkillsService;
  /** The environment the runtimes and providers see: the shell's, with the vault on top (live). */
  readonly env: NodeJS.ProcessEnv;
  private readonly server: DaemonServer;
  private readonly startedAt = Date.now();
  private readonly ownsStore: boolean;
  private schedules: (SchedulesApi & { start(): void; stop(): void }) | undefined;
  private readonly outbox: OutboxWorker | undefined;
  private stopping: Promise<void> | undefined;
  /** The conversation per Telegram chat (last turns), for the orchestrator's `messages`. */
  private readonly threads = new Map<string, ChatMessage[]>();
  /** One turn at a time per chat: the run in flight and the texts waiting for it. */
  private readonly inFlight = new Map<string, { runId: string; queue: string[] }>();
  private modelsCache: { at: number; models: ModelChoice[] } | undefined;

  constructor(private readonly opts: DaemonOptions = {}) {
    this.paths = opts.home ?? homePaths(opts.env);
    this.config = opts.config ?? loadDaemonConfig(this.paths.config);
    this.ownsStore = !opts.store;
    this.store = opts.store ?? new SqliteEventStore(this.paths.db);
    this.version = opts.version ?? '0.0.0';
    const log = opts.log ?? ((l: string) => console.log(l));
    this.secrets = new SecretsStore(this.paths.secrets);
    // one live object: a key set through the API is seen by the next run without a restart
    this.env = this.secrets.env(opts.env ?? process.env);
    this.skills = new SkillsService({ env: this.env, log: opts.log });
    this.channels =
      opts.channels ??
      defaultChannels(
        this.config,
        this.env,
        log,
        async (token) => {
          const items = await this.inbox.list();
          return items.find((i) => inboxToken(i.id) === token)?.id;
        },
        () => this.statusText(),
        opts.telegramApiBase,
      );
    this.telegramToken = this.config.channels.telegram
      ? this.env[this.config.channels.telegram.bot_token_env]
      : undefined;
    // with a SQLite store the outbox persists retries; an injected store delivers directly
    // (with a channel that may appear later, such as Telegram once its token is set)
    this.outbox =
      this.store instanceof SqliteEventStore
        ? new OutboxWorker({ repo: new OutboxRepo(this.store.db), channels: this.channels, log })
        : undefined;
    this.inbox = new InboxService({
      store: this.store,
      approvalTimeoutMs: this.config.approval_timeout_minutes * 60_000,
      now: opts.now,
      onItem: (item) => {
        if (this.outbox) this.outbox.enqueue(item);
        else
          for (const c of this.channels)
            c.notify(item).catch((e: unknown) =>
              log(`[${c.id}] ${e instanceof Error ? e.message : String(e)}`),
            );
      },
      onResolved: (item, a) => {
        void this.runs.onInboxResolved(item, a);
        this.outbox?.clear(item.id);
        for (const c of this.channels) c.resolved?.(item, a).catch(() => undefined);
      },
    });
    this.runs = new RunManager({
      store: this.store,
      runtimeStore:
        this.store instanceof SqliteEventStore ? new RuntimeEventsRepo(this.store.db) : undefined,
      inbox: this.inbox,
      config: this.config,
      log,
      env: this.env,
      ready: opts.discovery === false ? undefined : () => this.models(),
      summarizer: opts.summarize
        ? (org) => (t) => opts.summarize?.(t, org) ?? Promise.reject(new Error('no summariser'))
        : orgSummarizer(() => registryFor(this.env, opts.extraProviders)),
      conversationTokens: opts.conversationTokens,
      queryFn: opts.queryFn,
      graphify: opts.graphify,
      extraProviders: opts.extraProviders,
      vault: opts.vault,
      mockScript: opts.mockScript,
      now: opts.now,
      onFinished: (state, events, workflow, notePath) => {
        const report = buildRunReport(state, events, workflow, { notePath });
        if (this.schedules instanceof Routines) this.schedules.onFinished(state);
        log(`report: ${state.runId} ${state.status} → ${state.origin}`);
        // a conversation turn asked from a chat: its reply joins the thread, then the next
        // queued text goes out (dispatched children report, but are not turns)
        if (report.origin?.startsWith('telegram:') && !state.parentRunId) {
          if (report.reply)
            this.remember(report.origin, { role: 'assistant', content: report.reply });
          const flight = this.inFlight.get(report.origin);
          if (flight?.runId === state.runId) {
            this.inFlight.delete(report.origin);
            const next = flight.queue.shift();
            if (next !== undefined) {
              this.inFlight.set(report.origin, { runId: '', queue: flight.queue });
              void this.submitTurn(report.origin, next);
            }
          }
        }
        if (this.outbox) this.outbox.enqueueReport(report);
        else
          for (const c of this.channels)
            c.report?.(report).catch((e: unknown) =>
              log(`[${c.id}] report failed: ${e instanceof Error ? e.message : String(e)}`),
            );
      },
    });
    for (const c of this.channels) this.attach(c);
    this.server = new DaemonServer(this.paths.socket, this.serverDeps(opts, log));
  }

  /** Where the network listener answers (undefined without `listen` in daemon.yaml). */
  listenAddress(): { host: string; port: number; tls: boolean } | undefined {
    return this.server.address();
  }

  /**
   * `listen` from daemon.yaml with the token from the live env (vault or shell). Listening on
   * the network without a token would hand the machine to anyone who finds the port: refused.
   */
  private listenOptions(): ListenOptions | undefined {
    const l = this.config.listen;
    if (!l) return undefined;
    const token = this.env[l.token_env];
    if (!token)
      throw new Error(
        `daemon.yaml asks to listen on ${l.host}:${l.port} but ${l.token_env} is not set: put a token in the vault (shibaox keys set ${l.token_env} …) or drop \`listen\``,
      );
    return { host: l.host, port: l.port, token, tls: l.tls };
  }

  private serverDeps(opts: DaemonOptions, log: (line: string) => void): ServerDeps {
    return {
      store: this.store,
      runs: this.runs,
      inbox: this.inbox,
      schedules: () => this.schedules,
      draftRoutine: async (text, orgRoot) => {
        const org = loadOrg(orgRoot);
        const write = this.opts.routineDraft
          ? (prompt: string) => this.opts.routineDraft?.(prompt, org) as Promise<string>
          : routineDraftWriter(() => registryFor(this.env, this.opts.extraProviders))(org);
        if (!write) return undefined;
        const workflows = Object.values(org.workflows).map((w) => ({
          name: w.workflow,
          description: w.description,
        }));
        const answer = await write(draftPrompt(text, workflows));
        return parseDraft(
          answer,
          workflows.map((w) => w.name),
        );
      },
      health: () => this.health(),
      appDist: () => this.appDist(),
      profile: (path, orgRoot) =>
        profileFor(path, {
          vault: opts.vault ?? (orgRoot ? vaultDir(loadOrg(orgRoot), {}) : undefined),
          log: opts.log,
        }),
      models: () => this.models(),
      decisions: (limit) => this.decisions(limit),
      higgsfield: () => this.higgsfield(),
      higgsfieldLogin: () => this.higgsfieldLogin(),
      defaultOrg: () => this.defaultOrg(),
      projects: () => this.projects(),
      heartbeatMs: opts.heartbeatMs,
      keys: () => this.secrets.list(opts.env ?? process.env),
      mcpList: (org) => mcpList(org, this.env),
      mcpAdd: (org, req) => {
        const row = mcpAdd(org, req, this.env);
        log(`mcp server added: ${row.id} (${org})`);
        return row;
      },
      mcpRemove: (org, id) => {
        const r = mcpRemove(org, id);
        log(`mcp server removed: ${id} (${org})`);
        return r;
      },
      skills: {
        list: (org) => this.skills.list(org),
        add: async (org, req, o) => {
          const r = await this.skills.add(org, req, o);
          if (r.added.length) log(`skills added: ${r.added.map((a) => a.id).join(', ')} (${org})`);
          return r;
        },
        discover: (repo, path, o) => this.skills.discover(repo, path, o),
        remove: (org, id, o) => {
          const r = this.skills.remove(org, id, o);
          log(`skill removed: ${id} (${org})`);
          return r;
        },
      },
      roles: (org) => listRoles(org),
      putRole: (org, id, patch) => {
        const row = putRole(org, id, patch);
        log(`role updated: ${id} (${org})`);
        return row;
      },
      connectorRegistry: () => connectorRegistry(),
      skillSources: () => skillSources(),
      plugins: () =>
        pluginsStatus({
          higgsfield: () => this.higgsfield(),
          which: whichOnPath(this.env),
          env: this.env,
          decider: () => this.decider(),
        }),
      ...(opts.localPeer ? { localPeer: opts.localPeer } : {}),
      mcpTest: (id, org) => mcpTest(id, org, this.env, opts.log ?? (() => undefined)),
      mcpRemoteAllowed: async (org) => {
        const owned = [this.paths.org, ...(await this.projects()).map((p) => join(p.path, 'org'))];
        return owned.some((o) => resolve(o) === resolve(org));
      },
      setKey: (name, value) => {
        this.secrets.set(name, value);
        this.refreshEnv(opts.env ?? process.env);
        log(`key set: ${name}`);
      },
      unsetKey: (name) => {
        const removed = this.secrets.unset(name);
        this.refreshEnv(opts.env ?? process.env);
        if (removed) log(`key removed: ${name}`);
        return removed;
      },
      onShutdown: (o) => {
        void this.stop(o);
      },
      log,
    };
  }

  /** The Telegram token the running channel was built with (to notice a change). */
  private telegramToken: string | undefined;
  private telegramSync: Promise<void> = Promise.resolve();
  private started = false;

  /** Wires a channel's answers and messages into the inbox and the orchestrator. */
  private attach(c: Channel): void {
    c.onAnswer?.((id, a) =>
      this.inbox
        .answer(id, { ...a, via: c.id === 'telegram' ? 'telegram' : 'api' })
        .then(() => undefined),
    );
    c.onMessage?.((chatId, text) => this.onChatText(c, chatId, text));
  }

  /**
   * The Telegram channel follows the token in the live env: set through the vault, it starts
   * without a restart; removed, it stops; changed, it restarts with the new one.
   */
  private async syncTelegram(): Promise<void> {
    const tg = this.config.channels.telegram;
    if (!tg || this.opts.channels || this.stopping) return; // injected channels are the tests' business
    const token = this.env[tg.bot_token_env];
    if (token === this.telegramToken) return;
    const log = this.opts.log ?? ((l: string) => console.log(l));
    const current = this.channels.find((c) => c.id === 'telegram');
    if (current) {
      await current.stop?.().catch(() => undefined);
      const i = this.channels.indexOf(current);
      if (i >= 0) this.channels.splice(i, 1);
      log('telegram: channel stopped (token changed or removed)');
    }
    this.telegramToken = token;
    if (!token) return;
    const c = telegramChannel({
      token,
      chatId: tg.chat_id,
      log,
      lookup: async (t) => (await this.inbox.list()).find((i) => inboxToken(i.id) === t)?.id,
      status: () => this.statusText(),
      apiBase: this.opts.telegramApiBase,
    });
    this.attach(c);
    this.channels.push(c);
    if (this.started) await c.start?.();
    log('telegram: channel started with the token from the vault');
  }

  /** Rebuilds the live environment in place after the vault changed (nothing holds a copy). */
  private refreshEnv(base: NodeJS.ProcessEnv): void {
    const next = this.secrets.env(base);
    for (const k of Object.keys(this.env)) if (!(k in next)) delete this.env[k];
    Object.assign(this.env, next);
    this.modelsCache = undefined;
    this.warmModels(); // a new key may open a provider whose prices and windows runs need
    // one sync at a time: two quick key changes never race over the channel list
    this.telegramSync = this.telegramSync.then(() =>
      this.syncTelegram().catch((e) =>
        this.opts.log?.(`telegram: ${e instanceof Error ? e.message : String(e)}`),
      ),
    );
  }

  private modelsInFlight: Promise<ModelChoice[]> | undefined;
  /**
   * Every model a run can be pointed at. Local servers are probed at most every 10 s (each
   * `/model` keystroke asks, every run start asks); callers arriving during a probe share it.
   * OpenRouter's listing is cached for 10 minutes once it answers, so a failed probe (no
   * network at login) is tried again on the next call.
   */
  async models(): Promise<ModelChoice[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10_000)
      return this.modelsCache.models;
    this.modelsInFlight ??= discoverModels(registryFor(this.env, this.opts.extraProviders))
      .then((models) => {
        this.modelsCache = { at: Date.now(), models };
        return models;
      })
      .finally(() => {
        this.modelsInFlight = undefined;
      });
    return this.modelsInFlight;
  }

  private higgsfieldCache?: { at: number; view: Promise<HiggsfieldView> };
  private get higgsfieldProbe(): HiggsfieldProbe {
    return this.opts.higgsfield ?? defaultHiggsfieldProbe(this.env);
  }
  /** The Higgsfield status (CLI, account, MCP), cached for a minute. */
  higgsfield(): Promise<HiggsfieldView> {
    const signupUrl = this.config.partners?.higgsfield?.signup_url ?? HIGGSFIELD_SIGNUP_URL;
    // a signed-in answer is kept a minute; "not signed in" is read again next time (the user
    // may be logging in right now)
    if (!this.higgsfieldCache || Date.now() - this.higgsfieldCache.at > 60_000) {
      const view = higgsfieldStatus(this.higgsfieldProbe, { signupUrl });
      this.higgsfieldCache = { at: Date.now(), view };
      void view.then((v) => {
        if (!v.loggedIn && this.higgsfieldCache?.view === view) this.higgsfieldCache = undefined;
      });
    }
    return this.higgsfieldCache.view;
  }
  /** Starts the Higgsfield browser login on this machine; 409 when the CLI is missing. */
  async higgsfieldLogin(): Promise<LoginStart> {
    const v = await this.higgsfield();
    if (!v.cli.installed)
      throw new HttpError(
        409,
        'no_cli',
        `The Higgsfield CLI is not installed: ${HIGGSFIELD_INSTALL}`,
      );
    this.higgsfieldCache = undefined;
    return this.higgsfieldProbe.login();
  }

  /** Who decides decide nodes of the home org. */
  private async decider(): Promise<DeciderInfo> {
    const { root } = await this.defaultOrg();
    return deciderInfo(loadOrg(root), this.env, registryFor(this.env, this.opts.extraProviders));
  }

  /** Who decides (the home org's decision tier) and the latest decisions of the last 50 runs. */
  async decisions(limit = 20): Promise<DecisionsView> {
    const decider = await this.decider();
    const runs = (await this.store.listRuns())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 50);
    const decisions: DecisionRow[] = [];
    for (const r of runs)
      for (const e of await this.store.read(r.runId))
        if (e.type === 'DecisionMade')
          decisions.push({
            runId: r.runId,
            nodeId: e.nodeId,
            choice: e.choice,
            ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
            ...(e.by ? { by: e.by } : {}),
            at: e.at,
          });
    decisions.sort((a, b) => b.at.localeCompare(a.at));
    return { decider, decisions: decisions.slice(0, Math.max(1, Math.min(limit, 100))) };
  }

  /**
   * Discovery in the background: what the providers say about prices and context windows
   * is remembered process-wide, so the first run costs and measures right without anyone
   * opening `/model` first.
   */
  private warmModels(): void {
    if (this.opts.discovery === false) return;
    void this.models().catch((e) => {
      this.opts.log?.(`model discovery: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** `daemon 0.0.1 · 1 running · 0 queued · 2 need you` for `/status`. */
  async statusText(): Promise<string> {
    const h = this.health();
    const inbox = await this.inbox.list();
    const lines = [
      `daemon ${h.version} · ${h.runs.running} running · ${h.runs.queued} queued · up ${h.uptimeSeconds}s`,
    ];
    for (const i of inbox.slice(0, 5))
      lines.push(`▲ ${i.prompt.slice(0, 120)} (run ${i.runId.slice(0, 8)}, ${i.nodeId})`);
    if (inbox.length === 0) lines.push('Nothing needs you.');
    return lines.join('\n');
  }

  private remember(origin: string, m: ChatMessage): void {
    this.threads.set(
      origin,
      keepThread([...(this.threads.get(origin) ?? []), m], THREAD_TURNS * 2),
    );
  }

  /** Free text from a channel: a turn for the orchestrator on the configured org and project. */
  private async onChatText(channel: Channel, chatId: number, text: string): Promise<void> {
    const tg = this.config.channels.telegram;
    const say = (t: string) => channel.say?.(t).catch(() => undefined) ?? Promise.resolve();
    if (!tg?.org || !tg.project) {
      await say(
        'Set channels.telegram.org and project in daemon.yaml to talk to the orchestrator.',
      );
      return;
    }
    const origin = `telegram:${chatId}`;
    const flight = this.inFlight.get(origin);
    if (flight) {
      flight.queue.push(text);
      return;
    }
    this.inFlight.set(origin, { runId: '', queue: [] });
    await this.submitTurn(origin, text, say);
  }

  /** Submits one turn of a chat; the thread gets the user turn first, dropped again on failure. */
  private async submitTurn(
    origin: string,
    text: string,
    say: (t: string) => Promise<void> = async () => undefined,
  ): Promise<void> {
    const tg = this.config.channels.telegram;
    const flight = this.inFlight.get(origin);
    if (!tg?.org || !tg.project || !flight) return;
    const messages = [...(this.threads.get(origin) ?? [])];
    this.remember(origin, { role: 'user', content: text });
    try {
      const { runId, messages: used } = await this.runs.submit({
        orgRoot: tg.org,
        project: tg.project,
        workflow: tg.workflow,
        adapter: tg.adapter,
        input: text,
        messages,
        workspace: 'inplace',
        origin,
      });
      flight.runId = runId;
      // the daemon compacted the thread: the chat goes on from what the run got
      if (used) this.threads.set(origin, [...used, { role: 'user', content: text }]);
    } catch (e) {
      this.threads.set(origin, messages);
      await say(`✗ could not start: ${e instanceof Error ? e.message : String(e)}`);
      const next = flight.queue.shift();
      if (next === undefined) this.inFlight.delete(origin);
      else void this.submitTurn(origin, next, say);
    }
  }

  private appDistCache?: { value: string | undefined };
  /** The browser app's dist, resolved once (a path from the CLI, `null` for none, else the installed package). */
  private appDist(): string | undefined {
    if (!this.appDistCache)
      this.appDistCache = {
        value: this.opts.appDist === null ? undefined : (this.opts.appDist ?? resolveAppDist()),
      };
    return this.appDistCache.value;
  }

  health(): Health {
    return {
      version: this.version,
      pid: process.pid,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      runs: this.runs.active(),
      channels: this.channels.map((c) => c.id),
      ...(this.listenAddress() ? { listen: this.listenAddress() } : {}),
    };
  }

  /** Routines over the SQLite store: the old `schedules` table is moved in once. */
  private buildRoutines(): (SchedulesApi & { start(): void; stop(): void }) | undefined {
    if (!(this.store instanceof SqliteEventStore)) return undefined;
    const log = this.opts.log ?? ((l: string) => console.log(l));
    const repo = new RoutinesRepo(this.store.db);
    const moved = repo.migrateSchedules();
    if (moved > 0) log(`routines: ${moved} schedule(s) moved to the routines table`);
    return new Routines({
      repo,
      runs: this.runs,
      log,
      env: () => commandEnv(this.env),
      now: this.opts.now ? () => new Date(this.opts.now?.() ?? Date.now()) : undefined,
      vaultFor: (orgRoot) => {
        try {
          return vaultDir(loadOrg(orgRoot), { vault: this.opts.vault });
        } catch {
          return undefined;
        }
      },
    });
  }

  /** The home workspace: where the orchestrator works when no project is chosen. */
  get workspace(): string {
    return join(this.paths.root, 'workspace');
  }

  /**
   * Projects a dashboard may pick: `daemon.yaml projects` first, then the projects of recent
   * runs (newest first), then the home workspace, created here so a run can start in it.
   */
  async projects(): Promise<ProjectEntry[]> {
    const out: ProjectEntry[] = [];
    const seen = new Set<string>();
    const add = (path: string, source: ProjectEntry['source']) => {
      if (seen.has(path)) return;
      seen.add(path);
      out.push({ path, source });
    };
    for (const p of this.config.projects ?? []) add(p, 'config');
    for (const p of reposIn(this.config.projects_dir)) add(p, 'config');
    const runs = await this.runs.list();
    runs.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    for (const r of runs) if (r.project && r.project !== this.workspace) add(r.project, 'recent');
    mkdirSync(this.workspace, { recursive: true });
    add(this.workspace, 'workspace');
    return out;
  }

  /** The default org, created on first use. */
  async defaultOrg(): Promise<{ root: string; created: boolean }> {
    const claude =
      this.opts.claudeInstalled ??
      (await runArgv({ argv: ['which', 'claude'], cwd: '/', timeoutMs: 5_000 })).exitCode === 0;
    const r = ensureDefaultOrg(this.paths, { env: this.env, claude });
    if (r.created) (this.opts.log ?? console.log)(`default org created: ${r.root}`);
    return r;
  }

  async start(): Promise<void> {
    await this.defaultOrg();
    mkdirSync(this.workspace, { recursive: true });
    this.schedules = this.opts.schedules ? this.opts.schedules(this) : this.buildRoutines();
    this.server.listenOn = this.listenOptions();
    await this.server.listen();
    this.warmModels();
    writeFileSync(this.paths.pid, String(process.pid));
    for (const c of this.channels) await c.start?.();
    this.started = true;
    this.outbox?.start();
    await this.runs.start();
    this.schedules?.start();
  }

  stop(o: { force?: boolean } = {}): Promise<void> {
    this.stopping ??= (async () => {
      this.schedules?.stop();
      this.outbox?.stop();
      await this.runs.stop({ force: o.force, graceMs: o.force ? 0 : 60_000 });
      for (const c of this.channels) await c.stop?.();
      await this.server.close();
      if (existsSync(this.paths.pid)) unlinkSync(this.paths.pid);
      if (this.ownsStore && this.store instanceof SqliteEventStore) this.store.close();
    })();
    return this.stopping;
  }
}

/** The git repositories directly inside a directory, sorted; none when the directory is missing. */
function reposIn(dir: string | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, '.git')))
      .map((d) => join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

/** macOS notifications when enabled on Darwin; Telegram when configured with a token in the env. */
export function defaultChannels(
  config: DaemonConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  lookup?: (token: string) => Promise<InboxId | undefined>,
  status?: () => Promise<string>,
  apiBase?: string,
): Channel[] {
  const out: Channel[] = [];
  if (process.platform === 'darwin' && config.channels.macos.enabled) out.push(macosChannel());
  // GitHub answers only runs that came from an issue (`shibaox run --issue`): always on
  if (config.channels.github?.enabled !== false)
    out.push(githubChannel({ env: () => commandEnv(env), log }));
  const tg = config.channels.telegram;
  if (tg) {
    const token = env[tg.bot_token_env];
    if (token)
      out.push(telegramChannel({ token, chatId: tg.chat_id, log, lookup, status, apiBase }));
    else
      log(
        `warn: telegram is configured but ${tg.bot_token_env} is not set: set it with \`shibaox keys set ${tg.bot_token_env} …\` (no restart needed)`,
      );
  }
  return out;
}
