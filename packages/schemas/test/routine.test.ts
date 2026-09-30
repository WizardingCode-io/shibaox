import { describe, expect, it } from 'vitest';
import { RoutineFileSchema } from '../src/index.js';

describe('org/routines/<id>.yaml', () => {
  it('parses every trigger kind with sane defaults', () => {
    const cron = RoutineFileSchema.parse({
      routine: 'daily-check',
      on: { cron: '0 9 * * 1-5' },
      workflow: 'chat',
      input: 'what changed?',
    });
    expect(cron).toMatchObject({
      routine: 'daily-check',
      on: { type: 'cron', cron: '0 9 * * 1-5' },
      mode: 'always',
      every: 120,
    });
    expect(cron.enabled).toBeUndefined();
    expect(
      RoutineFileSchema.parse({
        routine: 'bugs',
        on: { github: 'issues', label: 'bug' },
        workflow: 'fix-issue',
      }).on,
    ).toEqual({
      type: 'github',
      watch: 'issues',
      label: 'bug',
    });
    expect(
      RoutineFileSchema.parse({
        routine: 'ci',
        on: { github: 'checks', branch: 'main' },
        workflow: 'chat',
        mode: 'on_change',
      }).mode,
    ).toBe('on_change');
    expect(
      RoutineFileSchema.parse({
        routine: 'u',
        on: { url: 'https://x.test/status' },
        workflow: 'chat',
        every: 300,
      }).every,
    ).toBe(300);
    expect(
      RoutineFileSchema.parse({ routine: 'f', on: { file: './TODO.md' }, workflow: 'chat' }).on,
    ).toEqual({ type: 'file', path: './TODO.md' });
    expect(
      RoutineFileSchema.parse({
        routine: 'c',
        on: { command: 'git fetch --dry-run' },
        workflow: 'chat',
        max_daily_usd: 3,
      }).max_daily_usd,
    ).toBe(3);
    expect(() =>
      RoutineFileSchema.parse({ routine: 'x', on: { github: 'stars' }, workflow: 'chat' }),
    ).toThrow();
    expect(() => RoutineFileSchema.parse({ routine: 'x', on: {}, workflow: 'chat' })).toThrow();
    expect(() =>
      RoutineFileSchema.parse({
        routine: 'x',
        on: { cron: '* * * * *', url: 'https://a' },
        workflow: 'chat',
      }),
    ).toThrow();
  });
});
