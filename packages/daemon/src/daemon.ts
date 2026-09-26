import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import type { QueryFn } from '@shibaox/adapter-claude-code';
import type { EventStore, MockScript } from '@shibaox/core';
import type { Graphify } from '@shibaox/memory';
import { SqliteEventStore } from '@shibaox/persistence-sqlite';
import type { ProviderEntry } from '@shibaox/providers';
import type { Channel } from './channels/types.js';
import { type DaemonConfig, loadDaemonConfig } from './config.js';
import { type HomePaths, homePaths } from './home.js';
import { InboxService } from './inbox.js';
import { RunManager } from './run-manager.js';
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
  channels?: Channel[];
  now?: () => string;
  version?: string;
  vault?: string;
  mockScript?: MockScript;
  /** Wires schedules and channels (set by the full daemon; tests may omit). */
  schedules?: (d: Daemon) => SchedulesApi & { start(): void; stop(): void };
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
  private readonly server: DaemonServer;
  private readonly startedAt = Date.now();
  private readonly ownsStore: boolean;
  private schedules: (SchedulesApi & { start(): void; stop(): void }) | undefined;
  private stopping: Promise<void> | undefined;

  constructor(private readonly opts: DaemonOptions = {}) {
    this.paths = opts.home ?? homePaths(opts.env);
    this.config = opts.config ?? loadDaemonConfig(this.paths.config);
    this.ownsStore = !opts.store;
    this.store = opts.store ?? new SqliteEventStore(this.paths.db);
    this.version = opts.version ?? '0.0.0';
    this.channels = opts.channels ?? [];
    const log = opts.log ?? ((l: string) => console.log(l));
    this.inbox = new InboxService({
      store: this.store,
      approvalTimeoutMs: this.config.approval_timeout_minutes * 60_000,
      now: opts.now,
      onItem: (item) => {
        for (const c of this.channels)
          c.notify(item).catch((e: unknown) =>
            log(`[${c.id}] ${e instanceof Error ? e.message : String(e)}`),
          );
      },
      onResolved: (item, a) => {
        void this.runs.onInboxResolved(item, a);
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
    });
    for (const c of this.channels)
      c.onAnswer?.((id, a) =>
        this.inbox
          .answer(id, { ...a, via: c.id === 'telegram' ? 'telegram' : 'api' })
          .then(() => undefined),
      );
    this.server = new DaemonServer(this.paths.socket, {
      store: this.store,
      runs: this.runs,
      inbox: this.inbox,
      schedules: () => this.schedules,
      health: () => this.health(),
      onShutdown: (o) => {
        void this.stop(o);
      },
      log,
    });
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
    this.schedules = this.opts.schedules?.(this);
    await this.server.listen();
    writeFileSync(this.paths.pid, String(process.pid));
    for (const c of this.channels) await c.start?.();
    await this.runs.start();
    this.schedules?.start();
  }

  stop(o: { force?: boolean } = {}): Promise<void> {
    this.stopping ??= (async () => {
      this.schedules?.stop();
      await this.runs.stop({ force: o.force, graceMs: o.force ? 0 : 60_000 });
      for (const c of this.channels) await c.stop?.();
      await this.server.close();
      if (existsSync(this.paths.pid)) unlinkSync(this.paths.pid);
      if (this.ownsStore && this.store instanceof SqliteEventStore) this.store.close();
    })();
    return this.stopping;
  }
}
