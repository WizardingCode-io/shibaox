import { describe, expect, it } from 'vitest';
import { replay } from '../src/index.js';

const at = '2026-10-02T10:00:00.000Z';
const created = (snapshot = true) => ({
  type: 'RunCreated',
  runId: 'r',
  at,
  workflow: 'chat',
  input: { spec: 'make a cat' },
  workspace: '/w',
  ...(snapshot
    ? {
        workflowSnapshot: {
          workflow: 'chat',
          conversation: true,
          start: 'reply',
          nodes: { reply: { type: 'task', role: 'assistant', instruction: 'answer' } },
        },
      }
    : {}),
});
const routed = [
  {
    type: 'DecisionMade',
    runId: 'r',
    nodeId: 'router',
    at,
    choice: 'media',
    confidence: 0.98,
    by: 'jev',
    cost: { usd: 0.00002, inputTokens: 500, outputTokens: 0 },
  },
  {
    type: 'DecisionMade',
    runId: 'r',
    nodeId: 'router:tier',
    at,
    choice: 'cheap',
    confidence: 0.9,
    by: 'jev',
  },
];

describe('router decisions (a node the workflow does not have)', () => {
  it('are kept as the run route, add their cost, and never become nodes', () => {
    const s = replay([created(), ...routed] as never);
    expect(s.nodes).toEqual({});
    expect(s.route).toEqual({
      intent: 'media',
      confidence: 0.98,
      tier: 'cheap',
      tierConfidence: 0.9,
      by: 'jev',
    });
    expect(s.spentUsd).toBeCloseTo(0.00002);
    expect(s.status).toBe('queued');
  });
  it('without a snapshot (older runs) the router ids are still recognised', () => {
    const s = replay([created(false), ...routed] as never);
    expect(s.nodes).toEqual({});
    expect(s.route?.intent).toBe('media');
  });
});
