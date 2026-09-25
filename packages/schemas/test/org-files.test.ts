import { describe, expect, it } from 'vitest';
import {
  CatalogEntrySchema,
  ModelsSchema,
  OrgFileSchema,
  RoleSchema,
  TeamSchema,
} from '../src/index.js';

describe('org file schemas', () => {
  it('role gets defaults for runtime, tier and permissions', () => {
    const r = RoleSchema.parse({ role: 'backend' });
    expect(r.runtime).toBe('claude-code');
    expect(r.model_tier).toBe('strong');
    expect(r.permissions.fs).toEqual(['workspace']);
  });
  it('team requires lead and at least one role', () => {
    expect(TeamSchema.safeParse({ team: 'eng', lead: 'tl' }).success).toBe(false);
    expect(TeamSchema.parse({ team: 'eng', lead: 'tl', roles: ['tl'] }).gates).toEqual([]);
  });
  it('org and models parse with defaults', () => {
    expect(OrgFileSchema.parse({ organization: 'wc' }).teams).toEqual([]);
    expect(ModelsSchema.parse({}).tiers).toEqual({});
  });
  it('catalog description is capped at 200 chars', () => {
    const long = 'x'.repeat(201);
    expect(
      CatalogEntrySchema.safeParse({ id: 'a', type: 'skill', description: long }).success,
    ).toBe(false);
  });
});
