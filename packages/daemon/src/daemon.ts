import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import type { EventStore, MockScript } from '@shibaox/core';
import type { Graphify } from '@shibaox/memory';
import { OutboxRepo, SchedulesRepo, SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
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
import { Scheduler } from './scheduler.js';
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
  private readonly server: DaemonServer;
  private readonly startedAt = Date.now();
  private readonly ownsStore: boolean;
  private schedules: (SchedulesApi & { start(): void; stop(): void }) | undefined;
  private readonly outbox: OutboxWorker | undefined;
  private stopping: Promise<void> | undefined;
  /** The conversation per Telegram chat (last turns), for the orchestrator's `messages`. */
  private readonly threads = new Map<string, ChatMessage[]>();

  constructor(private readonly opts: DaemonOptions = {}) {
    this.paths = opts.home ?? homePaths(opts.env);
    this.config = opts.config ?? loadDaemonConfig(this.paths.config);
    this.ownsStore = !opts.store;
    this.store = opts.store ?? new SqliteEventStore(this.paths.db);
    this.version = opts.version ?? '0.0.0';
    const log = opts.log ?? ((l: string) => console.log(l));
    this.channels =
      opts.channels ??
      defaultChannels(
        this.config,
        opts.env ?? process.env,
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
      env: opts.env,
      queryFn: opts.queryFn,
      graphify: opts.graphify,
      extraProviders: opts.extraProviders,
      vault: opts.vault,
      mockScript: opts.mockScript,
      now: opts.now,
      onFinished: (state, events, workflow, notePath) => {
        const report = buildRunReport(state, events, workflow, { notePath });
        log(`report: ${state.runId} ${state.status} → ${state.origin}`);
        if (report.reply && report.origin)
          this.remember(report.origin, { role: 'assistant', content: report.reply });
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
      onShutdown: (o) => {
        void this.stop(o);
      },
      log,
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
    try {
      await this.runs.submit({
        orgRoot: tg.org,
        project: tg.project,
        workflow: tg.workflow,
        adapter: tg.adapter,
        input: text,
        messages: this.threads.get(origin) ?? [],
        workspace: 'inplace',
        origin,
      });
      this.remember(origin, { role: 'user', content: text });
    } catch (e) {
      await say(`✗ could not start: ${e instanceof Error ? e.message : String(e)}`);
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
