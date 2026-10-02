import type { RunState } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { type Card, reduceTimeline, routeLabel, threadView } from '../src/index.js';

const at = '2026-10-02T10:00:00.000Z';
const chat = (over: Partial<RunState> = {}): RunState =>
  ({
    runId: 'r1',
    workflow: 'chat',
    status: 'completed',
    input: { spec: 'draw a cat', router: '[router] intent=media (0.98) tier=cheap risky=no' },
    workspace: '/w',
    nodes: { reply: { status: 'completed', attempts: 1 } },
    workflowSnapshot: {
      workflow: 'chat',
      conversation: true,
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant', instruction: 'Reply.' } },
    },
    pendingApprovals: [],
    pendingHumans: [],
    spentUsd: 0,
    route: { intent: 'media', confidence: 0.98, tier: 'cheap', tierConfidence: 0.9, by: 'jev' },
    ...over,
  }) as unknown as RunState;

const decision = (nodeId: string, choice: string, confidence: number) =>
  ({
    kind: 'run',
    seq: 1,
    cursor: '1',
    event: { type: 'DecisionMade', runId: 'r1', nodeId, at, choice, confidence, by: 'jev' },
  }) as never;

describe('the route of a chat turn', () => {
  it('router decisions never become cards', () => {
    const cards = reduceTimeline(chat(), [
      decision('router', 'media', 0.98),
      decision('router:tier', 'cheap', 0.9),
    ]);
    expect(cards.some((c) => 'nodeId' in c && String(c.nodeId).startsWith('router'))).toBe(false);
  });

  it('the agent message carries a route block: Routed by Jev · media (0.98) · cheap', () => {
    const cards: Card[] = [
      {
        kind: 'node',
        key: 'card:reply',
        nodeId: 'reply',
        type: 'task',
        status: 'completed',
        attempts: 1,
        blocks: [{ kind: 'text', key: 'x', text: 'Here is your cat.' }],
        tools: 0,
      },
    ];
    const v = threadView([{ state: chat(), cards }]);
    const [user, agent] = v.messages;
    // the user's message is the request, never the router's hint
    expect(user?.text).toBe('draw a cat');
    expect(user?.route).toBeUndefined();
    expect(agent?.route).toEqual({
      intent: 'media',
      confidence: 0.98,
      tier: 'cheap',
      label: 'Routed by Jev · media (0.98) · cheap',
    });
    // the tier shown is the one applied (Jev said cheap in the hint, the turn ran strong)
    const strong = threadView([
      {
        state: chat({
          route: { intent: 'media', confidence: 0.98, tier: 'strong', by: 'jev' } as never,
        }),
        cards,
      },
    ]);
    expect(strong.messages[1]?.route?.label).toBe('Routed by Jev · media (0.98) · strong');
    // an unrouted turn has none
    const plain = threadView([{ state: chat({ route: undefined }), cards }]);
    expect(plain.messages[1]?.route).toBeUndefined();
  });

  it('routeLabel without a tier or a confidence', () => {
    expect(routeLabel({ intent: 'chat' })).toBe('Routed by Jev · chat');
    expect(routeLabel({ intent: 'unsure', confidence: 0.41, tier: 'strong' })).toBe(
      'Routed by Jev · unsure (0.41) · strong',
    );
    expect(routeLabel({})).toBeUndefined();
  });
});
