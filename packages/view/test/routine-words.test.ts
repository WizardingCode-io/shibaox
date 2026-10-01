import { describe, expect, it } from 'vitest';
import { cronWords, triggerWords } from '../src/routine-words.js';

describe('routine words', () => {
  it('says common cron shapes in words, and shows the expression otherwise', () => {
    expect(cronWords('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(cronWords('30 18 * * *')).toBe('Every day at 18:30');
    expect(cronWords('0 16 * * 5')).toBe('Every Friday at 16:00');
    expect(cronWords('0 9 1 * *')).toBe('Monthly on day 1 at 09:00');
    expect(cronWords('0 * * * *')).toBe('Every hour');
    expect(cronWords('*/15 * * * *')).toBe('Every 15 minutes');
    expect(cronWords('0 9 * * 0,6')).toBe('Weekends at 09:00');
    expect(cronWords('5 4 * * 2#1')).toBe('cron 5 4 * * 2#1');
  });
  it('says every trigger kind', () => {
    expect(triggerWords({ type: 'manual' })).toBe('Manual');
    expect(triggerWords({ type: 'github', watch: 'issues', label: 'bug', repo: 'wc/app' })).toBe(
      'On issues labelled bug in wc/app',
    );
    expect(triggerWords({ type: 'github', watch: 'checks', branch: 'main' })).toBe(
      'When CI on main goes red',
    );
    expect(triggerWords({ type: 'url', url: 'https://x.y' })).toBe('When https://x.y changes');
    expect(triggerWords({ type: 'file', path: '/tmp/a' })).toBe('When /tmp/a changes');
    expect(triggerWords({ type: 'command', command: 'git fetch' })).toBe(
      'When `git fetch` changes',
    );
  });
});
