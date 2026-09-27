import { describe, expect, it } from 'vitest';
import { transitionsOf, WorkflowSchema } from '../src/index.js';

const valid = {
  workflow: 'hello',
  start: 'a',
  nodes: {
    a: { type: 'task', role: 'analyst', next: 'g' },
    g: { type: 'gate', gates: ['tests'], on_pass: 'd', on_fail: 'a' },
    d: {
      type: 'decide',
      by: 'lead',
      options: ['ship', 'rework'],
      next: { ship: 'h', rework: 'a' },
    },
    h: { type: 'human', action: 'approve' },
  },
};

describe('conversation workflows', () => {
  it('accepts conversation: true and leaves it unset otherwise', () => {
    const wf = WorkflowSchema.parse({
      workflow: 'chat',
      conversation: true,
      start: 'reply',
      nodes: { reply: { type: 'task', role: 'assistant' } },
    });
    expect(wf.conversation).toBe(true);
    expect(
      WorkflowSchema.parse({ workflow: 'x', start: 'a', nodes: { a: { type: 'task', role: 'r' } } })
        .conversation,
    ).toBeUndefined();
  });
});

describe('WorkflowSchema', () => {
  it('accepts a valid workflow and applies defaults', () => {
    const wf = WorkflowSchema.parse(valid);
    expect(wf.nodes.g).toMatchObject({ type: 'gate', max_retries: 3 });
  });

  it('rejects a next pointing to an unknown node, naming it', () => {
    const bad = {
      ...valid,
      nodes: { ...valid.nodes, a: { type: 'task', role: 'x', next: 'nope' } },
    };
    const r = WorkflowSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('nope');
  });

  it('rejects a decide whose options lack a transition', () => {
    const bad = {
      ...valid,
      nodes: {
        ...valid.nodes,
        d: { type: 'decide', by: 'lead', options: ['ship', 'rework'], next: { ship: 'h' } },
      },
    };
    expect(WorkflowSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown start node', () => {
    expect(WorkflowSchema.safeParse({ ...valid, start: 'zzz' }).success).toBe(false);
  });

  it('transitionsOf lists every outgoing node id', () => {
    const wf = WorkflowSchema.parse(valid);
    expect(transitionsOf(wf.nodes.g!)).toEqual(['d', 'a']);
    expect(transitionsOf(wf.nodes.d!).sort()).toEqual(['a', 'h']);
    expect(transitionsOf(wf.nodes.h!)).toEqual([]);
  });
});
