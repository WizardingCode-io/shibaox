import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveApprovals } from '@shibaox/core';
import { RoleSchema } from '@shibaox/schemas';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildTools } from '../src/tools.js';

const build = (
  role: Record<string, unknown>,
  extra: Parameters<typeof buildTools>[0]['extraTools'] = [],
) =>
  buildTools({
    workspace: mkdtempSync(join(tmpdir(), 'ws-')),
    role: RoleSchema.parse({ role: 'r', ...role }),
    runId: 'r',
    nodeId: 'n',
    ctx: { signal: new AbortController().signal, log: () => {} },
    emit: () => {},
    onFinish: () => {},
    approvals: new AutoApproveApprovals(),
    approvedCommands: {},
    onSuspend: () => {},
    commandTimeoutMs: 1000,
    maxFileBytes: 1000,
    extraTools: extra,
  });

describe('buildTools (3A)', () => {
  it('write_file exists only for roles with the write tool', () => {
    expect(Object.keys(build({ tools: ['echo'] }))).not.toContain('write_file');
    expect(Object.keys(build({ tools: ['echo'] }))).toContain('run_command');
    expect(Object.keys(build({ tools: ['write'] }))).toContain('write_file');
    expect(Object.keys(build({ tools: ['write'], capabilities: ['read-only'] }))).not.toContain(
      'write_file',
    );
  });
  it('web_fetch exists only with a network allowlist and refuses other hosts', async () => {
    expect(Object.keys(build({ tools: [] }))).not.toContain('web_fetch');
    const t = build({ tools: [], permissions: { network: ['github.com'] } });
    expect(Object.keys(t)).toContain('web_fetch');
    const r = (await t.web_fetch?.execute?.(
      { url: 'https://example.com/' },
      { toolCallId: 'x', messages: [] },
    )) as { error?: string };
    expect(r.error).toMatch(/host "example.com" is not allowed/);
  });
  it('extra tools are exposed under their own names', async () => {
    const t = build({ tools: [] }, [
      {
        name: 'ping',
        description: 'pong',
        input: z.object({ n: z.number() }),
        execute: async (i) => ({ pong: i.n }),
      },
    ]);
    expect(t.ping?.description).toBe('pong');
    expect(await t.ping?.execute?.({ n: 2 }, { toolCallId: 'x', messages: [] })).toEqual({
      pong: 2,
    });
  });
});
