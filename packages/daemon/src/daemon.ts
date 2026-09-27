import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import type { EventStore, MockScript } from '@shibaox/core';
import type { Graphify } from '@shibaox/memory';
import { OutboxRepo, SchedulesRepo, SqliteEventStore } from '@shibaox/persistence-sqlite';
import { discoverModels, type ModelChoice, type ProviderEntry } from '@shibaox/providers';
import { type ChatMessage, loadOrg } from '@shibaox/schemas';
import { macosChannel } from './channels/macos.js';
import { OutboxWorker } from './channels/outbox.js';
import { inboxToken, telegramChannel } from './channels/telegram.js';
import type { Channel } from './channels/types.js';
import { type DaemonConfig, loadDaemonConfig } from './config.js';
import { type HomePaths, homePaths } from './home.js';
import { type InboxId, InboxService } from './inbox.js';
import { RunManager } from './run-manager.js';
import { vaultDir } from './runs/notes.js';
import { profileFor } from './runs/profile.js';
import { buildRunReport } from './runs/report.js';
import { registryFor } from './runtime.js';
import { Scheduler } from './scheduler.js';
import { SecretsStore } from './secrets.js';
import { DaemonServer, type Health, type SchedulesApi } from './server.js';

export interface DaemonOptions {
  home?: HomePaths;
  config?: DaemonConfig;
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
  /** Schedules; by default a cron Scheduler over the SQLite store (none with an injected store). */
  schedules?: (d: Daemon) => SchedulesApi & { start(): void; stop(): void };
}

/** Turns kept per Telegram chat for the orchestrator's conversation. */
const THREAD_TURNS = 20;

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
      );
    // with a SQLite store the outbox persists retries; an injected store delivers directly
    this.outbox =
      this.store instanceof SqliteEventStore && this.channels.length > 0
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
      inbox: this.inbox,
      config: this.config,
      log,
      env: this.env,
      queryFn: opts.queryFn,
      graphify: opts.graphify,
      extraProviders: opts.extraProviders,
      vault: opts.vault,
      mockScript: opts.mockScript,
      now: opts.now,
      onFinished: (state, events, workflow, notePath) => {
        const report = buildRunReport(state, events, workflow, { notePath });
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
    for (const c of this.channels) {
      c.onAnswer?.((id, a) =>
        this.inbox
          .answer(id, { ...a, via: c.id === 'telegram' ? 'telegram' : 'api' })
          .then(() => undefined),
      );
      c.onMessage?.((chatId, text) => this.onChatText(c, chatId, text));
    }
    this.server = new DaemonServer(this.paths.socket, {
      store: this.store,
      runs: this.runs,
      inbox: this.inbox,
      schedules: () => this.schedules,
      health: () => this.health(),
      profile: (path, orgRoot) =>
        profileFor(path, {
          vault: opts.vault ?? (orgRoot ? vaultDir(loadOrg(orgRoot), {}) : undefined),
          log: opts.log,
        }),
      models: async () => {
        // local servers are probed at most every 10 s (each `/model` keystroke asks the list)
        if (this.modelsCache && Date.now() - this.modelsCache.at < 10_000)
          return this.modelsCache.models;
        const models = await discoverModels(registryFor(this.env, opts.extraProviders));
        this.modelsCache = { at: Date.now(), models };
        return models;
      },
      keys: () => this.secrets.list(opts.env ?? process.env),
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
    });
  }

  /** Rebuilds the live environment in place after the vault changed (nothing holds a copy). */
  private refreshEnv(base: NodeJS.ProcessEnv): void {
    const next = this.secrets.env(base);
    for (const k of Object.keys(this.env)) if (!(k in next)) delete this.env[k];
    Object.assign(this.env, next);
    this.modelsCache = undefined;
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
    const t = this.threads.get(origin) ?? [];
    t.push(m);
    this.threads.set(origin, t.slice(-THREAD_TURNS * 2));
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
      const { runId } = await this.runs.submit({
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
    } catch (e) {
      this.threads.set(origin, messages);
      await say(`✗ could not start: ${e instanceof Error ? e.message : String(e)}`);
      const next = flight.queue.shift();
      if (next === undefined) this.inFlight.delete(origin);
      else void this.submitTurn(origin, next, say);
    }
  }

  health(): Health {
    return {
      version: this.version,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      runs: this.runs.active(),
      channels: this.channels.map((c) => c.id),
    };
  }

  async start(): Promise<void> {
    this.schedules = this.opts.schedules
      ? this.opts.schedules(this)
      : this.store instanceof SqliteEventStore
        ? new Scheduler({
            repo: new SchedulesRepo(this.store.db),
            runs: this.runs,
            log: this.opts.log ?? ((l: string) => console.log(l)),
            now: this.opts.now ? () => new Date(this.opts.now?.() ?? Date.now()) : undefined,
          })
        : undefined;
    await this.server.listen();
    writeFileSync(this.paths.pid, String(process.pid));
    for (const c of this.channels) await c.start?.();
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

/** macOS notifications when enabled on Darwin; Telegram when configured with a token in the env. */
export function defaultChannels(
  config: DaemonConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  lookup?: (token: string) => Promise<InboxId | undefined>,
  status?: () => Promise<string>,
): Channel[] {
  const out: Channel[] = [];
  if (process.platform === 'darwin' && config.channels.macos.enabled) out.push(macosChannel());
  const tg = config.channels.telegram;
  if (tg) {
    const token = env[tg.bot_token_env];
    if (token) out.push(telegramChannel({ token, chatId: tg.chat_id, log, lookup, status }));
    else log(`warn: telegram is configured but ${tg.bot_token_env} is not set: channel disabled`);
  }
  return out;
}
