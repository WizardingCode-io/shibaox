import type { InboxAnswer, InboxId, InboxItem } from '../inbox.js';
import type { RunReport } from '../runs/report.js';

/** Where inbox items are announced and, for some channels, answered. */
export interface Channel {
  id: 'macos' | 'telegram';
  /** May throw; the outbox retries with backoff. */
  notify(item: InboxItem): Promise<void>;
  /** The item was answered (from any channel). */
  resolved?(item: InboxItem, answer: InboxAnswer): Promise<void>;
  /** A run asked for from this side ended (or waits): channels that can show it implement this. */
  report?(report: RunReport): Promise<void>;
  onAnswer?(cb: (id: InboxId, a: { approved: boolean; note?: string }) => Promise<void>): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
