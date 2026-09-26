import type { InboxAnswer, InboxId, InboxItem } from '../inbox.js';

/** Where inbox items are announced and, for some channels, answered. */
export interface Channel {
  id: 'macos' | 'telegram';
  /** May throw; the outbox retries with backoff. */
  notify(item: InboxItem): Promise<void>;
  /** The item was answered (from any channel). */
  resolved?(item: InboxItem, answer: InboxAnswer): Promise<void>;
  onAnswer?(cb: (id: InboxId, a: { approved: boolean; note?: string }) => Promise<void>): void;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}
