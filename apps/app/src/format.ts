export const money = (usd: number): string =>
  usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

/** `09:41` in the local clock. */
export function clock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** `3.1s`, `420ms`, `2m 13s`. */
export function duration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`;
}

/** A short model label for the composer (`claude-opus` from `anthropic/claude-opus-4`). */
export function shortModel(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  return ref.split('/').pop() ?? ref;
}

export const RUN_STATUS_TONE: Record<
  string,
  'neutral' | 'shiba' | 'matcha' | 'info' | 'warning' | 'danger'
> = {
  queued: 'neutral',
  running: 'info',
  waiting_human: 'warning',
  waiting_approval: 'warning',
  paused_budget: 'warning',
  completed: 'matcha',
  failed: 'danger',
  cancelled: 'neutral',
};
export const RUN_STATUS_WORD: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_human: 'Needs you',
  waiting_approval: 'Needs you',
  paused_budget: 'Paused',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** `in 2 h`, `3 min ago`, `now`; a date beyond two weeks. */
export function relative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return 'now';
  if (abs >= 86_400_000 * 14) return when(iso);
  const unit =
    abs < 3_600_000
      ? `${Math.round(abs / 60_000)} min`
      : abs < 86_400_000
        ? `${Math.round(abs / 3_600_000)} h`
        : `${Math.round(abs / 86_400_000)} d`;
  return diff < 0 ? `${unit} ago` : `in ${unit}`;
}

/** `30 Sep, 09:00` in the local clock (the date matters for routines). */
export function when(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
