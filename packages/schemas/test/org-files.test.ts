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
  it('role permissions default is not shared between separate parses', () => {
    const a = RoleSchema.parse({ role: 'backend' });
    const b = RoleSchema.parse({ role: 'frontend' });
    expect(a.permissions).not.toBe(b.permissions);
    a.permissions.fs.push('extra');
    expect(b.permissions.fs).toEqual(['workspace']);
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

describe('org.yaml setup', () => {
  it('is auto by default and can be off for every run of the org', () => {
    expect(OrgFileSchema.parse({ organization: 'o' }).setup).toBe('auto');
    expect(OrgFileSchema.parse({ organization: 'o', setup: 'off' }).setup).toBe('off');
    expect(() => OrgFileSchema.parse({ organization: 'o', setup: 'maybe' })).toThrow();
  });
});

describe('models.yaml routing', () => {
  it('accepts routing: { jev, cheap_min_confidence } and refuses a confidence outside 0..1', () => {
    expect(
      ModelsSchema.parse({ routing: { jev: false, cheap_min_confidence: 0.8 } }).routing,
    ).toEqual({ jev: false, cheap_min_confidence: 0.8 });
    expect(ModelsSchema.parse({}).routing).toBeUndefined();
    expect(() => ModelsSchema.parse({ routing: { cheap_min_confidence: 2 } })).toThrow();
  });
});
