import type { RoutineTrigger } from '@wizardingcode/shibaox-schemas';

/** What the dialog's Frequency field offers: presets over cron, watchers, or by hand. */
export type Frequency =
  | { kind: 'manual' }
  | { kind: 'hourly' }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; day: number }
  | { kind: 'monthly'; time: string; dayOfMonth: number }
  | { kind: 'cron'; cron: string }
  | {
      kind: 'github';
      watch: 'issues' | 'prs' | 'checks';
      repo?: string;
      label?: string;
      branch?: string;
    }
  | { kind: 'url'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'command'; command: string };

export const FREQUENCIES: { id: Frequency['kind']; label: string; hint: string }[] = [
  { id: 'manual', label: 'Manual', hint: 'only when you press Run now' },
  { id: 'hourly', label: 'Hourly', hint: 'at the top of every hour' },
  { id: 'daily', label: 'Daily at…', hint: 'every day at a time' },
  { id: 'weekdays', label: 'Weekdays at…', hint: 'Monday to Friday at a time' },
  { id: 'weekly', label: 'Weekly on…', hint: 'one day a week at a time' },
  { id: 'monthly', label: 'Monthly on…', hint: 'one day a month at a time' },
  { id: 'cron', label: 'Custom cron', hint: 'five fields, the daemon machine clock' },
  {
    id: 'github',
    label: 'GitHub issues, PRs or checks',
    hint: 'when something new or red appears',
  },
  {
    id: 'url',
    label: 'When a page changes',
    hint: 'a public http(s) address, looked at every few minutes',
  },
  { id: 'file', label: 'When a file changes', hint: 'a path on the daemon machine' },
  {
    id: 'command',
    label: "When a command's output changes",
    hint: 'a shell command on the daemon machine',
  },
];

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const hm = (time: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const h = m ? Number(m[1]) : 9;
  const mi = m ? Number(m[2]) : 0;
  return [Math.min(23, Math.max(0, h)), Math.min(59, Math.max(0, mi))];
};

/** The trigger a frequency means. */
export function toTrigger(f: Frequency): RoutineTrigger {
  switch (f.kind) {
    case 'manual':
      return { type: 'manual' };
    case 'hourly':
      return { type: 'cron', cron: '0 * * * *' };
    case 'daily': {
      const [h, m] = hm(f.time);
      return { type: 'cron', cron: `${m} ${h} * * *` };
    }
    case 'weekdays': {
      const [h, m] = hm(f.time);
      return { type: 'cron', cron: `${m} ${h} * * 1-5` };
    }
    case 'weekly': {
      const [h, m] = hm(f.time);
      return { type: 'cron', cron: `${m} ${h} * * ${f.day}` };
    }
    case 'monthly': {
      const [h, m] = hm(f.time);
      return { type: 'cron', cron: `${m} ${h} ${f.dayOfMonth} * *` };
    }
    case 'cron':
      return { type: 'cron', cron: f.cron.trim() };
    case 'github':
      return {
        type: 'github',
        watch: f.watch,
        ...(f.repo?.trim() ? { repo: f.repo.trim() } : {}),
        ...(f.label?.trim() ? { label: f.label.trim() } : {}),
        ...(f.branch?.trim() ? { branch: f.branch.trim() } : {}),
      };
    case 'url':
      return { type: 'url', url: f.url.trim() };
    case 'file':
      return { type: 'file', path: f.path.trim() };
    case 'command':
      return { type: 'command', command: f.command.trim() };
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The preset a trigger came from (custom cron when none matches). */
export function fromTrigger(t: RoutineTrigger): Frequency {
  switch (t.type) {
    case 'manual':
      return { kind: 'manual' };
    case 'github':
      return {
        kind: 'github',
        watch: t.watch,
        ...(t.repo ? { repo: t.repo } : {}),
        ...(t.label ? { label: t.label } : {}),
        ...(t.branch ? { branch: t.branch } : {}),
      };
    case 'url':
      return { kind: 'url', url: t.url };
    case 'file':
      return { kind: 'file', path: t.path };
    case 'command':
      return { kind: 'command', command: t.command };
    case 'cron': {
      const f = t.cron.trim().split(/\s+/);
      if (f.length === 5) {
        const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
        const num = (x: string) => /^\d+$/.test(x);
        if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*')
          return { kind: 'hourly' };
        if (num(min) && num(hour) && mon === '*') {
          const time = `${pad(Number(hour))}:${pad(Number(min))}`;
          if (dom === '*' && dow === '*') return { kind: 'daily', time };
          if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time };
          if (dom === '*' && num(dow) && Number(dow) <= 7)
            return { kind: 'weekly', time, day: Number(dow) % 7 };
          if (num(dom) && dow === '*') return { kind: 'monthly', time, dayOfMonth: Number(dom) };
        }
      }
      return { kind: 'cron', cron: t.cron };
    }
  }
}
