/**
 * One merge at a time per project: merges queue in the order they arrive, each rebasing on
 * what the previous one landed. In-process (the daemon is the only writer of a project).
 */
export class MergeQueue {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly waiting = new Map<string, number>();

  /** How many merges are ahead of a new one for `key`. */
  ahead(key: string): number {
    return this.waiting.get(key) ?? 0;
  }

  enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    this.waiting.set(key, this.ahead(key) + 1);
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(job, job).finally(() => {
      this.waiting.set(key, Math.max(0, this.ahead(key) - 1));
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    this.tails.set(key, next);
    return next;
  }
}

/** The queue every engine of this process shares unless one is injected. */
export const defaultMergeQueue = new MergeQueue();
