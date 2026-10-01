import type { RoutineTrigger } from '@wizardingcode/shibaox-schemas';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: string) => n.padStart(2, '0');

/** A cron expression in words for the common shapes; the expression itself otherwise. */
export function cronWords(cron: string): string {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return `cron ${cron}`;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const simple = (x: string) => /^\d+$/.test(x);
  const at = simple(min) && simple(hour) ? `${pad(hour)}:${pad(min)}` : undefined;
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*')
    return `Every ${min.slice(2)} minutes`;
  if (at && dom === '*' && mon === '*') {
    if (dow === '*') return `Every day at ${at}`;
    if (dow === '1-5') return `Weekdays at ${at}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${at}`;
    if (simple(dow) && Number(dow) <= 7) return `Every ${DAYS[Number(dow) % 7]} at ${at}`;
  }
  if (at && simple(dom) && mon === '*' && dow === '*')
    return `Monthly on day ${Number(dom)} at ${at}`;
  return `cron ${cron}`;
}

/** A trigger in words, for cards and the CLI. */
export function triggerWords(t: RoutineTrigger): string {
  switch (t.type) {
    case 'manual':
      return 'Manual';
    case 'cron':
      return cronWords(t.cron);
    case 'github': {
      const where = t.repo ? ` in ${t.repo}` : '';
      if (t.watch === 'checks')
        return `When CI on ${t.branch ?? 'the default branch'} goes red${where}`;
      const what = t.watch === 'issues' ? 'issues' : 'pull requests';
      return `On ${what}${t.label ? ` labelled ${t.label}` : ''}${where}`;
    }
    case 'url':
      return `When ${t.url} changes`;
    case 'file':
      return `When ${t.path} changes`;
    case 'command':
      return `When \`${t.command}\` changes`;
  }
}
