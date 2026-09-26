import { randomUUID } from 'node:crypto';
import {
  type ApprovalAnswer,
  type ApprovalHandler,
  type ApprovalRequest,
  argvHash,
  type EventStore,
  type HumanAnswer,
  type HumanHandler,
  type HumanRequest,
  isTerminal,
  replay,
  type RunState,
} from '@shibaox/core';

export type InboxId = `human:${string}:${string}` | `approval:${string}`;

export interface InboxItem {
  id: InboxId;
  kind: 'human' | 'approval';
  runId: string;
  nodeId: string;
  at: string;
  /** The human prompt, or the command awaiting approval. */
  prompt: string;
  detail: { action?: string; role?: string; program?: string; category?: 'push' | 'deploy' };
}

export interface InboxAnswer {
  approved: boolean;
  note?: string;
  via: 'cli' | 'telegram' | 'api';
}

export interface InboxServiceOptions {
  store: EventStore;
  now?: () => string;
  /** A blocked approval past this resolves `deferred`; the item stays pending. */
  approvalTimeoutMs: number;
  newId?: () => string;
  /** A new pending item (channels notify from here). */
  onItem?: (item: InboxItem) => void;
  /** An item was answered. */
  onResolved?: (item: InboxItem, answer: InboxAnswer) => void;
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`inbox item ${id} not found`);
    this.name = 'NotFoundError';
  }
}
export class AlreadyResolvedError extends Error {
  constructor(id: string) {
    super(`inbox item ${id} was already answered`);
    this.name = 'AlreadyResolvedError';
  }
}

interface Blocked {
  resolve: (a: ApprovalAnswer) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

const approvalItem = (p: RunState['pendingApprovals'][number]): InboxItem => ({
  id: `approval:${p.approvalId}`,
  kind: 'approval',
  runId: p.runId,
  nodeId: p.nodeId,
  at: p.at,
  prompt: p.command,
  detail: { role: p.role, program: p.program, category: p.category },
});

/**
 * The persistent inbox: tool approvals (`ToolApprovalRequested`/`Resolved`) and human nodes
 * (`HumanRequested`/`Responded`), derived from the event log. `request` blocks the calling
 * adapter until `answer`, a timeout or an abort; `ask` always defers (the daemon resumes the
 * run after the answer).
 */
export class InboxService implements ApprovalHandler, HumanHandler {
  private readonly blocked = new Map<string, Blocked>();
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(private readonly opts: InboxServiceOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.newId = opts.newId ?? (() => randomUUID().replace(/-/g, '').slice(0, 12));
  }

  async request(req: ApprovalRequest, opts: { signal?: AbortSignal }): Promise<ApprovalAnswer> {
    const approvalId = this.newId();
    const at = this.now();
    await this.opts.store.append({
      type: 'ToolApprovalRequested',
      runId: req.runId,
      nodeId: req.nodeId,
      at,
      approvalId,
      role: req.role,
      tool: req.tool,
      program: req.program,
      category: req.category,
      command: req.command,
      argvHash: argvHash(req.argv),
    });
    this.opts.onItem?.({
      id: `approval:${approvalId}`,
      kind: 'approval',
      runId: req.runId,
      nodeId: req.nodeId,
      at,
      prompt: req.command,
      detail: { role: req.role, program: req.program, category: req.category },
    });
    return new Promise<ApprovalAnswer>((resolve) => {
      const done = (a: ApprovalAnswer) => {
        const b = this.blocked.get(approvalId);
        if (!b) return;
        b.cleanup();
        this.blocked.delete(approvalId);
        resolve(a);
      };
      const deferred = () => done({ deferred: true, approvalId });
      const timer = setTimeout(deferred, this.opts.approvalTimeoutMs);
      timer.unref?.();
      opts.signal?.addEventListener('abort', deferred, { once: true });
      this.blocked.set(approvalId, {
        resolve: done,
        timer,
        cleanup: () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', deferred);
        },
      });
      if (opts.signal?.aborted) deferred();
    });
  }

  /** Human nodes always wait in the inbox; the engine already recorded `HumanRequested`. */
  async ask(req: HumanRequest): Promise<HumanAnswer> {
    this.opts.onItem?.({
      id: `human:${req.runId}:${req.nodeId}`,
      kind: 'human',
      runId: req.runId,
      nodeId: req.nodeId,
      at: this.now(),
      prompt: req.prompt,
      detail: { action: req.action },
    });
    return { deferred: true };
  }

  hasBlocked(approvalId: string): boolean {
    return this.blocked.has(approvalId);
  }

  /** Pending items of every non-terminal run, oldest first. */
  async list(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    for (const run of await this.opts.store.listRuns()) {
      if (isTerminal(run.status)) continue;
      const events = await this.opts.store.read(run.runId);
      const state = replay(events);
      for (const p of state.pendingHumans) {
        const requested = events.find((e) => e.type === 'HumanRequested' && e.nodeId === p.nodeId);
        items.push({
          id: `human:${run.runId}:${p.nodeId}`,
          kind: 'human',
          runId: run.runId,
          nodeId: p.nodeId,
          at: requested?.at ?? run.updatedAt,
          prompt: p.prompt,
          detail: { action: p.action },
        });
      }
      for (const p of state.pendingApprovals) items.push(approvalItem(p));
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Records the answer (`HumanResponded` or `ToolApprovalResolved`) and releases a blocked
   * adapter when there is one. Whether the run continues is the run manager's job.
   */
  async answer(id: string, a: InboxAnswer): Promise<{ runId: string; kind: 'human' | 'approval' }> {
    const item = await this.find(id);
    if (item.kind === 'human') {
      await this.opts.store.append({
        type: 'HumanResponded',
        runId: item.runId,
        nodeId: item.nodeId,
        at: this.now(),
        approved: a.approved,
        note: a.note,
      });
    } else {
      const approvalId = item.id.slice('approval:'.length);
      await this.opts.store.append({
        type: 'ToolApprovalResolved',
        runId: item.runId,
        nodeId: item.nodeId,
        at: this.now(),
        approvalId,
        approved: a.approved,
        note: a.note,
        via: a.via,
      });
      this.blocked.get(approvalId)?.resolve({ approved: a.approved, note: a.note });
    }
    this.opts.onResolved?.(item, a);
    return { runId: item.runId, kind: item.kind };
  }

  private async find(id: string): Promise<InboxItem> {
    const [kind] = id.split(':');
    if (kind !== 'human' && kind !== 'approval') throw new NotFoundError(id);
    const pending = (await this.list()).find((i) => i.id === id);
    if (pending) return pending;
    // distinguish "never existed" from "already answered" for a clear 404 vs 409
    if (await this.existed(id)) throw new AlreadyResolvedError(id);
    throw new NotFoundError(id);
  }

  private async existed(id: string): Promise<boolean> {
    if (id.startsWith('human:')) {
      const [, runId, nodeId] = id.split(':');
      const events = runId ? await this.opts.store.read(runId) : [];
      return events.some((e) => e.type === 'HumanRequested' && e.nodeId === nodeId);
    }
    const approvalId = id.slice('approval:'.length);
    for (const run of await this.opts.store.listRuns()) {
      const events = await this.opts.store.read(run.runId);
      if (events.some((e) => e.type === 'ToolApprovalRequested' && e.approvalId === approvalId))
        return true;
    }
    return false;
  }
}
