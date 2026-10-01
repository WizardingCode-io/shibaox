import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskJob } from '@wizardingcode/shibaox-core';
import { loadOrg, type Role } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { higgsfieldPlan } from '../src/runs/higgsfield-gate.js';
import { roleMcpSpecs } from '../src/runtime.js';
import { scaffoldOrg } from '../src/templates.js';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const role = (o: { mcp?: string[]; tools?: string[] }) =>
  ({ role: 'r', mcp: o.mcp ?? [], tools: o.tools ?? [] }) as unknown as Role;

describe('higgsfieldPlan', () => {
  it('gives a Higgsfield role the API tools in api mode and the MCP upload in account mode', () => {
    const viaMcp = role({ mcp: ['higgsfield'] });
    const viaCmd = role({ tools: ['higgsfield'] });
    const none = role({ mcp: ['playwright'], tools: ['read'] });
    expect(higgsfieldPlan(viaMcp, 'api', true)).toEqual({
      apiTools: true,
      upload: false,
      skipMcp: true,
    });
    expect(higgsfieldPlan(viaMcp, 'account', true)).toEqual({
      apiTools: false,
      upload: true,
      skipMcp: false,
    });
    expect(higgsfieldPlan(viaMcp, 'account', false)).toEqual({
      apiTools: false,
      upload: false,
      skipMcp: false,
    });
    expect(higgsfieldPlan(viaCmd, 'api', false)).toEqual({
      apiTools: true,
      upload: false,
      skipMcp: true,
    });
    expect(higgsfieldPlan(viaCmd, 'account', true)).toEqual({
      apiTools: false,
      upload: false,
      skipMcp: false,
    });
    expect(higgsfieldPlan(none, 'api', true)).toEqual({
      apiTools: false,
      upload: false,
      skipMcp: true,
    });
  });
});

describe('roleMcpSpecs', () => {
  it("builds the role's catalog servers and leaves out the skipped ones", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-gate-'));
    tmp.push(dir);
    scaffoldOrg(dir);
    const org = loadOrg(join(dir, 'org'));
    const assistant = org.roles.assistant as Role;
    const job = {
      role: { ...assistant, mcp: ['higgsfield', 'playwright'] },
    } as unknown as TaskJob;
    expect(roleMcpSpecs(org, {}, job).map((s) => s.id)).toEqual(['higgsfield', 'playwright']);
    expect(roleMcpSpecs(org, {}, job, (id) => id === 'higgsfield').map((s) => s.id)).toEqual([
      'playwright',
    ]);
    const unknown = { role: { ...assistant, mcp: ['nope'] } } as unknown as TaskJob;
    expect(() => roleMcpSpecs(org, {}, unknown)).toThrow(/not in the catalog/);
  });
});
