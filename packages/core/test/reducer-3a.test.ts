import type { RunEvent } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { conversationOf, isEventTurn } from '../src/executors/types.js';
import { replay } from '../src/run/reducer.js';

const at = '2026-09-27T00:00:00.000Z';

describe('phase 3A state', () => {
  it('RunCreated.parentRunId lands in the state', () => {
    const created: RunEvent = {
      type: 'RunCreated',
      runId: 'c',
      at,
      workflow: 'wf',
      input: {},
      workspace: '/w',
      parentRunId: 'p',
    };
    expect(replay([created]).parentRunId).toBe('p');
    expect(replay([{ ...created, origin: 'schedule:s1' }]).origin).toBe('schedule:s1');
    expect(replay([created]).origin).toBeUndefined();
    expect(replay([{ ...created, parentRunId: undefined }]).parentRunId).toBeUndefined();
  });

  it('isEventTurn is the structural flag, never the text', () => {
    expect(isEventTurn({ spec: 'x', event: true })).toBe(true);
    expect(isEventTurn({ spec: '[event] x' })).toBe(false);
    expect(isEventTurn({})).toBe(false);
  });

  it('conversationOf keeps well-formed messages only', () => {
    expect(
      conversationOf({
        messages: [{ role: 'user', content: 'a' }, { role: 'x', content: 'b' }, 'junk', null],
      }),
    ).toEqual([{ role: 'user', content: 'a' }]);
    expect(conversationOf({})).toEqual([]);
    expect(conversationOf({ messages: 'nope' })).toEqual([]);
  });
});
