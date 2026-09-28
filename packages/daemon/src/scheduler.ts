import { isTerminal, type RunStatus } from '@wizardingcode/shibaox-core';
import type { ScheduleRow, SchedulesRepo } from '@wizardingcode/shibaox-persistence-sqlite';
import { Cron } from 'croner';
import type { RunManager } from './run-manager.js';
import type { AdapterId } from './runtime.js';

export interface SchedulerOptions {
  repo: SchedulesRepo;
  runs: Pick<RunManager, 'submit' | 'state'>;
  log: (line: string) => void;
  now?: () => Date;
  /** Tick interval of `start()` (default 60 s). */
  intervalMs?: number;
}

export type ScheduleInput = Omit<ScheduleRow, 'id' | 'createdAt' | 'enabled' | 'lastRunId'> & {
  enabled?: boolean;
};

/** Cron schedules that submit runs; a schedule whose last run is still active is skipped. */
export class Scheduler {
  private readonly now: () => Date;
  private lastTick: Date;
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly opts: SchedulerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.lastTick = this.now();
  }

  list(): ScheduleRow[] {
    return this.opts.repo.list();
  }

  add(s: ScheduleInput): ScheduleRow {
    try {
      new Cron(s.cron);
    } catch {
      throw new Error(`invalid cron expression: ${s.cron}`);
    }
    return this.opts.repo.add({ ...s, enabled: s.enabled ?? true });
  }

  remove(id: string): void {
    if (!this.opts.repo.remove(id)) throw new Error(`schedule ${id} not found`);
  }

  async runNow(id: string): Promise<{ runId: string }> {
    const s = this.opts.repo.get(id);
    if (!s) throw new Error(`schedule ${id} not found`);
    return this.fire(s);
  }

  /** Fires every enabled schedule with an occurrence in `(lastTick, now]`. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    try {
      for (const s of this.opts.repo.list()) {
        if (!s.enabled) continue;
        const due = new Cron(s.cron).nextRun(this.lastTick);
        if (!due || due.getTime() > now.getTime()) continue;
        if (s.lastRunId && !(await this.finished(s.lastRunId))) {
          this.opts.log(`Skipped schedule ${s.id}: previous run ${s.lastRunId} is still running`);
          continue;
        }
        try {
          await this.fire(s);
        } catch (e) {
          this.opts.log(
            `Schedule ${s.id} failed to submit: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      this.lastTick = now;
      this.ticking = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async finished(runId: string): Promise<boolean> {
    try {
      return isTerminal((await this.opts.runs.state(runId)).status as RunStatus);
    } catch {
      return true; // an unknown run never blocks the schedule
    }
  }

  private async fire(s: ScheduleRow): Promise<{ runId: string }> {
    const { runId } = await this.opts.runs.submit({
      orgRoot: s.orgRoot,
      project: s.project,
      workflow: s.workflow,
      input: s.input,
      adapter: s.adapter as AdapterId | undefined,
      budgetUsd: s.budgetUsd,
      origin: `schedule:${s.id}`,
    });
    this.opts.repo.setLastRun(s.id, runId);
    return { runId };
  }
}
