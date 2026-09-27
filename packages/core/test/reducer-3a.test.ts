import type { RunEvent } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { conversationOf } from '../src/executors/types.js';
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
    expect(replay([{ ...created, parentRunId: undefined }]).parentRunId).toBeUndefined();
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
