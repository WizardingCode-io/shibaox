import { describe, expect, it } from 'vitest';
import { replay, ScriptedDecider } from '../src/index.js';

describe('who decided', () => {
  it('a scripted decider signs its decisions', async () => {
    const d = new ScriptedDecider({ judge: 'ship' });
    await expect(
      d.decide({
        runId: 'r',
        nodeId: 'judge',
        by: 'lead',
        question: 'q',
        options: ['ship'],
        context: { input: {}, previousOutputs: {} },
      }),
    ).resolves.toMatchObject({ choice: 'ship', by: 'scripted' });
  });
  it('the run state remembers who decided a node', () => {
    const at = '2026-10-01T10:00:00.000Z';
    const s = replay([
      {
        type: 'RunCreated',
        runId: 'r',
        at,
        workflow: 'w',
        input: {},
        workspace: '/w',
        workflowSnapshot: {
          workflow: 'w',
          team: 't',
          start: 'judge',
          nodes: { judge: { type: 'decide', by: 'lead', question: 'q', options: ['ship'] } },
        },
      },
      { type: 'RunStarted', runId: 'r', at },
      {
        type: 'DecisionMade',
        runId: 'r',
        nodeId: 'judge',
        at,
        choice: 'ship',
        confidence: 0.9,
        by: 'jev',
      },
    ] as never);
    expect(s.nodes.judge).toMatchObject({ choice: 'ship', decidedBy: 'jev' });
  });
});
