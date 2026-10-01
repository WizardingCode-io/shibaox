import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrg } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { deciderInfo, registryFor } from '../src/runtime.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});
function org(models?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'decider-'));
  tmp.push(dir);
  scaffoldOrg(dir);
  if (models) writeFileSync(join(dir, 'org', 'models.yaml'), models);
  return loadOrg(join(dir, 'org'));
}
const info = (o: ReturnType<typeof org>, env: Record<string, string>) =>
  deciderInfo(o, env, registryFor(env));

describe('deciderInfo says what buildRuntime would use', () => {
  it('no key at all: decide nodes always pick ship', () => {
    const i = info(org(), {});
    expect(i).toMatchObject({ kind: 'none', ref: 'jev-latest', usable: false });
    expect(i.reason).toMatch(/TYPESAFE_API_KEY/);
    expect(i.reason).toMatch(/always pick ship/);
  });
  it('a TypeSafe key with a jev-* decision tier: Jev decides', () => {
    expect(info(org(), { TYPESAFE_API_KEY: 'k' })).toMatchObject({
      kind: 'jev',
      ref: 'jev-latest',
      usable: true,
    });
  });
  it('a model ref as the decision tier, with its key: that model decides', () => {
    const o = org(
      'providers: {}\ntiers: { strong: anthropic/claude-sonnet-5, cheap: anthropic/claude-haiku-4-5, decision: openrouter/typesafe/jev-router }\nroles: {}\ngates: {}\n',
    );
    expect(info(o, { OPENROUTER_API_KEY: 'k' })).toMatchObject({
      kind: 'model',
      ref: 'openrouter/typesafe/jev-router',
      usable: true,
    });
  });
  it('an unusable decision tier falls back to the strong tier, and says so', () => {
    const o = org(
      'providers: {}\ntiers: { strong: anthropic/claude-sonnet-5, cheap: anthropic/claude-haiku-4-5, decision: openrouter/typesafe/jev-router }\nroles: {}\ngates: {}\n',
    );
    const i = info(o, { ANTHROPIC_API_KEY: 'k' });
    expect(i).toMatchObject({ kind: 'model', ref: 'anthropic/claude-sonnet-5', usable: true });
    expect(i.reason).toMatch(/openrouter\/typesafe\/jev-router/);
    expect(i.reason).toMatch(/strong tier/);
  });
});
