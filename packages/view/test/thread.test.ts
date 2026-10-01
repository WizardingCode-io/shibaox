import type { RunState } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { agentStatusOf, type Card, requestText, threadView } from '../src/index.js';

const state = (over: Partial<RunState> & { input?: Record<string, unknown> }): RunState =>
  ({
    runId: 'r1',
    workflow: 'chat',
    status: 'completed',
    input: { spec: 'Find me a hotel in Porto' },
    workspace: '/w',
    nodes: {},
    pendingApprovals: [],
    pendingHumans: [],
    spentUsd: 0.012,
    ...over,
  }) as unknown as RunState;

const node = (
  blocks: Card extends { kind: 'node' } ? never : unknown[],
  status = 'completed',
): Card =>
  ({
    kind: 'node',
    key: 'card:reply',
    nodeId: 'reply',
    type: 'task',
    status,
    attempts: 1,
    blocks,
    tools: 0,
  }) as Card;

describe('threadView', () => {
  it('one turn: the request as a user message, the streamed text as the agent reply, tool blocks attached to it', () => {
    const cards: Card[] = [
      node([
        {
          kind: 'tool',
          key: 't1',
          id: 'a',
          name: 'browser.search',
          summary: 'hotels',
          input: {},
          status: 'done',
          ms: 3100,
        },
        { kind: 'text', key: 'x1', text: 'On it. I compared 24 hotels.' },
      ]),
    ];
    const v = threadView([{ state: state({}), cards }]);
    expect(v.title).toBe('Find me a hotel in Porto');
    expect(v.status).toBe('online');
    expect(v.messages.map((m) => [m.from, m.text])).toEqual([
      ['user', 'Find me a hotel in Porto'],
      ['agent', 'On it. I compared 24 hotels.'],
    ]);
    expect(v.messages[1]?.blocks.filter((b) => b.kind === 'tool')).toHaveLength(1);
    expect(v.messages[1]?.pending).toBe(false);
  });
  it('several turns keep order; a running last turn without text is pending; event turns are hidden from the user side', () => {
    const turns = [
      {
        state: state({ runId: 'r1', input: { spec: 'first' } }),
        cards: [node([{ kind: 'text', key: 'x', text: 'one' }])],
      },
      {
        state: state({ runId: 'r2', status: 'running', input: { spec: 'second', messages: [] } }),
        cards: [node([], 'running')],
      },
      {
        state: state({
          runId: 'r3',
          status: 'running',
          input: { spec: 'workflow x finished', event: true },
        }),
        cards: [],
      },
    ];
    const v = threadView(turns);
    expect(v.messages.map((m) => [m.from, m.text, m.pending ?? false])).toEqual([
      ['user', 'first', false],
      ['agent', 'one', false],
      ['user', 'second', false],
      ['agent', '', true],
    ]);
    expect(v.status).toBe('working');
    expect(v.title).toBe('first');
  });
  it('agentStatusOf maps run states to the AgentStatus words', () => {
    expect(agentStatusOf(undefined)).toBe('idle');
    expect(agentStatusOf(state({ status: 'running' }))).toBe('working');
    expect(agentStatusOf(state({ status: 'waiting_human' }))).toBe('waiting');
    expect(
      agentStatusOf(state({ status: 'running', pendingApprovals: [{ approvalId: 'a' }] } as never)),
    ).toBe('waiting');
    expect(agentStatusOf(state({ status: 'completed' }))).toBe('online');
    expect(agentStatusOf(state({ status: 'failed' }))).toBe('error');
    expect(agentStatusOf(state({ status: 'cancelled' }))).toBe('error');
    expect(agentStatusOf(state({ status: 'paused_budget' }))).toBe('waiting');
    expect(agentStatusOf(state({ status: 'queued' }))).toBe('working');
  });
  it('requestText reads the request off the input', () => {
    expect(requestText({ spec: ' hi ' })).toBe('hi');
    expect(requestText({ input: 'x' })).toBe('x');
    expect(requestText(undefined)).toBe('');
  });

  it('parts keep the original order of text and tool calls, text runs joined as they were', () => {
    const cards: Card[] = [
      node([
        { kind: 'text', key: 'x1', text: 'Let me look.' },
        {
          kind: 'tool',
          key: 't1',
          id: 'a',
          name: 'read_file',
          summary: 'a.ts',
          input: {},
          status: 'done',
        },
        { kind: 'text', key: 'x2', text: 'Found it: ' },
        { kind: 'text', key: 'x3', text: 'the bug is on line 3.', parentId: undefined },
        { kind: 'file', key: 'f1', path: 'a.ts' },
        { kind: 'text', key: 'x4', text: 'Fixed.' },
      ]),
    ];
    const v = threadView([{ state: state({}), cards }]);
    const agent = v.messages[1];
    expect(agent?.parts.map((p) => (p.kind === 'text' ? ['text', p.text] : [p.kind]))).toEqual([
      ['text', 'Let me look.'],
      ['tool'],
      ['text', 'Found it: the bug is on line 3.'],
      ['file'],
      ['text', 'Fixed.'],
    ]);
    // the aggregate text and blocks stay for the title, the sidebar and the tool count
    expect(agent?.text).toContain('Fixed.');
    expect(agent?.blocks).toHaveLength(2);
  });

  it('parts of two task nodes stay apart, with keys of their own', () => {
    const cards: Card[] = [
      node([{ kind: 'text', key: 'text:0', text: 'Done.' }]),
      { ...node([{ kind: 'text', key: 'text:0', text: 'Next.' }]), key: 'node:b', nodeId: 'b' },
    ];
    const v = threadView([{ state: state({}), cards }]);
    const parts = v.messages[1]?.parts ?? [];
    expect(parts.map((p) => (p.kind === 'text' ? p.text : p.kind))).toEqual(['Done.', 'Next.']);
    expect(new Set(parts.map((p) => p.key)).size).toBe(2);
  });
});
