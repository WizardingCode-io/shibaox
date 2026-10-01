import { describe, expect, it } from 'vitest';
import { fromTrigger, toTrigger } from '../src/screens/scheduled/frequency.js';

describe('frequency presets', () => {
  it('turns presets into triggers', () => {
    expect(toTrigger({ kind: 'weekdays', time: '09:00' })).toEqual({
      type: 'cron',
      cron: '0 9 * * 1-5',
    });
    expect(toTrigger({ kind: 'daily', time: '18:30' })).toEqual({
      type: 'cron',
      cron: '30 18 * * *',
    });
    expect(toTrigger({ kind: 'weekly', time: '16:00', day: 5 })).toEqual({
      type: 'cron',
      cron: '0 16 * * 5',
    });
    expect(toTrigger({ kind: 'monthly', time: '09:00', dayOfMonth: 1 })).toEqual({
      type: 'cron',
      cron: '0 9 1 * *',
    });
    expect(toTrigger({ kind: 'hourly' })).toEqual({ type: 'cron', cron: '0 * * * *' });
    expect(toTrigger({ kind: 'cron', cron: '*/5 * * * *' })).toEqual({
      type: 'cron',
      cron: '*/5 * * * *',
    });
    expect(toTrigger({ kind: 'manual' })).toEqual({ type: 'manual' });
    expect(toTrigger({ kind: 'github', watch: 'issues', label: 'bug', repo: '' })).toEqual({
      type: 'github',
      watch: 'issues',
      label: 'bug',
    });
    expect(toTrigger({ kind: 'url', url: 'https://x.y' })).toEqual({
      type: 'url',
      url: 'https://x.y',
    });
  });
  it('reads a trigger back into the preset that made it, custom cron for the rest', () => {
    for (const f of [
      { kind: 'weekdays', time: '09:00' },
      { kind: 'daily', time: '18:30' },
      { kind: 'weekly', time: '16:00', day: 5 },
      { kind: 'monthly', time: '09:00', dayOfMonth: 15 },
      { kind: 'hourly' },
      { kind: 'manual' },
      { kind: 'file', path: '/tmp/x' },
      { kind: 'command', command: 'ls' },
      { kind: 'github', watch: 'checks', branch: 'main', repo: 'a/b' },
    ] as const) {
      expect(fromTrigger(toTrigger(f as never))).toEqual(f);
    }
    expect(fromTrigger({ type: 'cron', cron: '5 4 * * 2#1' })).toEqual({
      kind: 'cron',
      cron: '5 4 * * 2#1',
    });
  });
});
