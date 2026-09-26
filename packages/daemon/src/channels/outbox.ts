import type { OutboxRepo } from '@shibaox/persistence-sqlite';
import type { InboxItem } from '../inbox.js';
import type { Channel } from './types.js';

/** Retry delays by attempt; past the last one, hourly. */
export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000] as const;
const HOURLY_MS = 3_600_000;

export interface OutboxWorkerOptions {
  repo: OutboxRepo;
  channels: Channel[];
  log: (line: string) => void;
  now?: () => Date;
  /** Polling interval of `start()` (default 5 s). */
  intervalMs?: number;
}

/** Delivers inbox notifications to every channel, retrying failures with backoff. */
export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private readonly now: () => Date;

  constructor(private readonly opts: OutboxWorkerOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** One row per channel; delivery happens on the next tick. */
  enqueue(item: InboxItem): void {
    const at = this.now().toISOString();
    for (const c of this.opts.channels) this.opts.repo.enqueue(c.id, item.id, item, at);
  }

  /** The item was answered: nothing left to announce. */
  clear(inboxId: string): void {
    this.opts.repo.removeForInbox(inboxId);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const row of this.opts.repo.due(this.now().toISOString())) {
        const channel = this.opts.channels.find((c) => c.id === row.channel);
        if (!channel) {
          this.opts.repo.remove(row.id);
          continue;
        }
        try {
          await channel.notify(JSON.parse(row.payload) as InboxItem);
          this.opts.repo.remove(row.id);
        } catch (e) {
          const delay = BACKOFF_MS[row.attempts] ?? HOURLY_MS;
          this.opts.repo.retry(row.id, new Date(this.now().getTime() + delay).toISOString());
          this.opts.log(
            `[${channel.id}] notification for ${row.inboxId} failed (attempt ${row.attempts + 1}): ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 5_000);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
