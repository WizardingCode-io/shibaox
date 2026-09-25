import { TeamSchema, WorkflowSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { injectTeamGates } from '../src/index.js';

const team = TeamSchema.parse({ team: 'eng', lead: 'tl', roles: ['tl'], gates: ['lint', 'tests'] });

describe('injectTeamGates', () => {
  it('inserts a gate before a terminal node reached from a task', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'w',
      start: 'a',
      nodes: { a: { type: 'task', role: 'tl', next: 'h' }, h: { type: 'human', action: 'ok' } },
    });
    const out = injectTeamGates(wf, team);
    expect(out.nodes.a).toMatchObject({ next: 'team-gate:h' });
    expect(out.nodes['team-gate:h']).toEqual({
      type: 'gate',
      gates: ['lint', 'tests'],
      on_pass: 'h',
      on_fail: 'a',
      max_retries: 3,
    });
    expect(WorkflowSchema.safeParse(out).success).toBe(true);
    expect(wf.nodes.a).toMatchObject({ next: 'h' }); // original untouched
  });
  it('rewires decide transitions too', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'w',
      start: 'd',
      nodes: {
        d: { type: 'decide', by: 'tl', options: ['x', 'y'], next: { x: 'h', y: 'h' } },
        h: { type: 'human', action: 'ok' },
      },
    });
    const out = injectTeamGates(wf, team);
    expect(out.nodes.d).toMatchObject({ next: { x: 'team-gate:h', y: 'team-gate:h' } });
  });
  it('does nothing when a gate node already covers the team gates', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'w',
      start: 'a',
      nodes: {
        a: { type: 'task', role: 'tl', next: 'g' },
        g: { type: 'gate', gates: ['lint', 'tests'], on_pass: 'h', on_fail: 'a' },
        h: { type: 'human', action: 'ok' },
      },
    });
    expect(injectTeamGates(wf, team)).toEqual(wf);
  });
  it('does nothing when the team has no gates', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'w',
      start: 'a',
      nodes: { a: { type: 'task', role: 'tl' } },
    });
    expect(injectTeamGates(wf, TeamSchema.parse({ team: 't', lead: 'tl', roles: ['tl'] }))).toEqual(
      wf,
    );
  });
});
