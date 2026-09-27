import { describe, expect, it } from 'vitest';
import { ChatMessageSchema, RoleSchema } from '../src/index.js';

describe('RoleSchema limits', () => {
  it('accepts per-role limits and rejects non-positive ones', () => {
    const r = RoleSchema.parse({ role: 'a', max_steps: 40, max_turns: 80, budget_usd: 1.5 });
    expect([r.max_steps, r.max_turns, r.budget_usd]).toEqual([40, 80, 1.5]);
    expect(RoleSchema.parse({ role: 'a' }).max_steps).toBeUndefined();
    expect(() => RoleSchema.parse({ role: 'a', max_steps: 0 })).toThrow();
    expect(() => RoleSchema.parse({ role: 'a', max_turns: 1.5 })).toThrow();
    expect(() => RoleSchema.parse({ role: 'a', budget_usd: -1 })).toThrow();
  });

  it('ChatMessageSchema keeps role and content only', () => {
    expect(ChatMessageSchema.parse({ role: 'user', content: 'hi', extra: 1 })).toEqual({
      role: 'user',
      content: 'hi',
    });
    expect(() => ChatMessageSchema.parse({ role: 'system', content: 'x' })).toThrow();
  });
});
