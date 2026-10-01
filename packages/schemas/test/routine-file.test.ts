import { describe, expect, it } from 'vitest';
import { RoutineFileSchema, RoutineTriggerSchema } from '../src/routine.js';

describe('routine schema: manual trigger, model, approvals, description', () => {
  it('a manual trigger exists, as `on: manual: true` in a file', () => {
    expect(RoutineTriggerSchema.parse({ type: 'manual' })).toEqual({ type: 'manual' });
    const f = RoutineFileSchema.parse({
      routine: 'report',
      on: { manual: true },
      workflow: 'chat',
      description: 'A report, when asked',
      model: 'anthropic/claude-opus',
      approvals: 'auto',
    });
    expect(f.on).toEqual({ type: 'manual' });
    expect(f.mode).toBe('always');
    expect(f.model).toBe('anthropic/claude-opus');
    expect(f.approvals).toBe('auto');
    expect(f.description).toBe('A report, when asked');
  });

  it('approvals take inbox, auto or skip only; manual with another trigger is refused', () => {
    expect(
      RoutineFileSchema.safeParse({
        routine: 'x',
        on: { cron: '* * * * *' },
        workflow: 'chat',
        approvals: 'yes',
      }).success,
    ).toBe(false);
    expect(
      RoutineFileSchema.safeParse({
        routine: 'x',
        on: { manual: true, cron: '* * * * *' },
        workflow: 'chat',
      }).success,
    ).toBe(false);
    expect(
      RoutineFileSchema.parse({ routine: 'x', on: { cron: '* * * * *' }, workflow: 'chat' })
        .approvals,
    ).toBeUndefined();
  });
});
