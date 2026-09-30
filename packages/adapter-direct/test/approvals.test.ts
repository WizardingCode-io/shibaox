import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterError,
  type ApprovalHandler,
  type ApprovalRequest,
  argvHash,
  collectRun,
  type RuntimeEvent,
  type TaskJob,
} from '@wizardingcode/shibaox-core';
import { ProviderRegistry } from '@wizardingcode/shibaox-providers';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectAdapter } from '../src/index.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await fake?.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const registry = (baseURL: string) =>
  new ProviderRegistry(
    [
      {
        id: 'fake',
        name: 'Fake',
        kind: 'openai-compatible',
        base_url: baseURL,
        auth: { type: 'none' },
        models: [],
        pricing: {},
        verify: false,
        capabilities: { tools: true },
      },
    ],
    {},
  );
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'direct-appr-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  return dir;
}

const job = (workspace: string, extra: Partial<TaskJob> = {}): TaskJob => ({
  runId: 'r',
  nodeId: 'implement',
  role: RoleSchema.parse({
    role: 'backend',
    tools: ['git'],
    permissions: { approval_required: ['push'] },
  }),
  instruction: 'push',
  input: {},
  workspace,
  context: { previousOutputs: {} },
  approvedCommands: {},
  ...extra,
});

function handler(answer: (r: ApprovalRequest) => Promise<unknown>) {
  const requests: ApprovalRequest[] = [];
  const h: ApprovalHandler = {
    request: async (r) => {
      requests.push(r);
      return (await answer(r)) as never;
    },
  };
  return Object.assign(h, { requests });
}

/** Model: run `git push origin main`, then finish. */
const pushThenFinish = () =>
  startFakeOpenAI((_r, turn) =>
    turn === 0
      ? { toolCalls: [{ name: 'run_command', args: { command: 'git push origin main' } }] }
      : { toolCalls: [{ name: 'finish', args: { output: {}, summary: 'done' } }] },
  );

describe('direct adapter approvals', () => {
  it('asks the handler and runs the command once approved', async () => {
    const ws = gitRepo();
    fake = await pushThenFinish();
    const h = handler(async () => ({ approved: true }));
    const adapter = new DirectAdapter({
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      approvals: h,
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(job(ws), ctx())) events.push(e);
    expect(h.requests[0]).toMatchObject({
      program: 'git',
      category: 'push',
      command: 'git push origin main',
      argv: ['git', 'push', 'origin', 'main'],
      runId: 'r',
      nodeId: 'implement',
      role: 'backend',
    });
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'run_command') as {
      id?: string;
      durationMs?: number;
      output: { exitCode?: number; error?: string };
    };
    // no remote: the push fails, but it ran (exit code reported, no permission error)
    expect(typeof result.output.exitCode).toBe('number');
    expect(result.output.error).toBeUndefined();
    expect(typeof result.id).toBe('string');
    expect(typeof result.durationMs).toBe('number');
    const use = events.find((e) => e.type === 'tool_use' && e.name === 'run_command') as {
      id?: string;
    };
    expect(use.id).toBe(result.id);
    expect(events.at(-1)?.type).toBe('result');
  });

  it('a deferred answer stops the task with approval_pending and the approval id', async () => {
    const ws = gitRepo();
    fake = await pushThenFinish();
    const adapter = new DirectAdapter({
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      approvals: handler(async () => ({ deferred: true, approvalId: 'a-7' })),
    });
    const err = await collectRun(adapter, job(ws), ctx()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toMatchObject({ reason: 'approval_pending', approvalId: 'a-7' });
  });

  it('does not ask again for a command already approved on the node', async () => {
    const ws = gitRepo();
    fake = await pushThenFinish();
    const h = handler(async () => {
      throw new Error('must not be asked');
    });
    const adapter = new DirectAdapter({
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      approvals: h,
    });
    const r = await collectRun(
      adapter,
      job(ws, { approvedCommands: { [argvHash(['git', 'push', 'origin', 'main'])]: true } }),
      ctx(),
    );
    expect(r.summary).toBe('done');
    expect(h.requests).toHaveLength(0);
  });

  it('denies push for a role without approval_required', async () => {
    const ws = gitRepo();
    fake = await pushThenFinish();
    const h = handler(async () => ({ approved: true }));
    const adapter = new DirectAdapter({
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      approvals: h,
    });
    const events: RuntimeEvent[] = [];
    const role = RoleSchema.parse({ role: 'backend', tools: ['git'] });
    for await (const e of adapter.run(job(ws, { role }), ctx())) events.push(e);
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'run_command') as {
      output: { error?: string };
    };
    expect(result.output.error).toContain('push requires approval_required');
    expect(h.requests).toHaveLength(0);
  });
});

describe('semantic approvals (direct)', () => {
  const setup = async (
    role: Record<string, unknown>,
    script: Parameters<typeof startFakeOpenAI>[0],
    o: { protected?: string[]; before?: (ws: string) => void } = {},
  ) => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    o.before?.(ws);
    fake = await startFakeOpenAI(script);
    const asked: ApprovalRequest[] = [];
    const approvals: ApprovalHandler = {
      async request(req) {
        asked.push(req);
        return { approved: true };
      },
    };
    const adapter = new DirectAdapter({
      approvals,
      registry: registry(fake.baseURL),
      resolveRef: () => 'fake/m',
      protectedPaths: () => o.protected ?? [],
    });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(
      {
        ...job(ws),
        role: RoleSchema.parse({
          role: 'backend',
          tools: ['read', 'write', 'node', 'curl'],
          ...role,
        }),
      },
      ctx(),
    ))
      events.push(e);
    // tool results arrive in completion order: pair each with its call through the id
    const result = (name: string, match?: (input: Record<string, unknown>) => boolean) => {
      const use = events.find(
        (e) =>
          e.type === 'tool_use' &&
          e.name === name &&
          (!match || match(e.input as Record<string, unknown>)),
      ) as { id: string } | undefined;
      return JSON.stringify(events.find((e) => e.type === 'tool_result' && e.id === use?.id));
    };
    return { ws, asked, events, result };
  };
  const finishAfter =
    (calls: { name: string; args: Record<string, unknown> }[]) => (_r: unknown, turn: number) =>
      turn === 0
        ? { toolCalls: calls }
        : { toolCalls: [{ name: 'finish', args: { output: {}, summary: 'ok' } }] };

  it('node -e is an execute escape hatch: refused without approval_required, asked with it', async () => {
    const a = await setup(
      {},
      finishAfter([{ name: 'run_command', args: { command: 'node -e 1' } }]),
    );
    expect(a.result('run_command')).toMatch(/execute requires approval_required/);
    expect(a.asked).toHaveLength(0);
    const b = await setup(
      { permissions: { approval_required: ['execute'] } },
      finishAfter([{ name: 'run_command', args: { command: 'node -e console.log(7)' } }]),
    );
    expect(b.asked[0]).toMatchObject({ category: 'execute', program: 'node', tool: 'Bash' });
    expect(b.result('run_command')).toContain('7');
  });
  it('curl to an allowed host runs; another host is a network approval', async () => {
    const a = await setup(
      { permissions: { network: ['127.0.0.1'], approval_required: ['network'] } },
      finishAfter([
        { name: 'run_command', args: { command: 'curl -s http://127.0.0.1:9/x' } },
        { name: 'run_command', args: { command: 'curl -s https://evil.example/x' } },
      ]),
    );
    expect(a.asked.map((r) => [r.category, r.command])).toEqual([
      ['network', 'curl -s https://evil.example/x'],
    ]);
    const b = await setup(
      { permissions: { network: ['127.0.0.1'] } },
      finishAfter([{ name: 'run_command', args: { command: 'curl -s https://evil.example/x' } }]),
    );
    expect(b.result('run_command')).toMatch(/network requires approval_required/);
  });
  it('a protected path (role globs + shibaox.yaml) is refused or asked as a file approval', async () => {
    const calls = [
      { name: 'write_file', args: { path: 'infra/prod.tf', content: 'x' } },
      { name: 'write_file', args: { path: 'src/ok.ts', content: 'y' } },
    ];
    const a = await setup({ permissions: { protected: ['infra/**'] } }, finishAfter(calls));
    expect(a.result('write_file', (i) => i.path === 'infra/prod.tf')).toMatch(
      /infra\/prod\.tf.*protected/,
    );
    expect(existsSync(join(a.ws, 'infra/prod.tf'))).toBe(false);
    expect(existsSync(join(a.ws, 'src/ok.ts'))).toBe(true);
    const b = await setup(
      { permissions: { approval_required: ['protected'] } },
      finishAfter(calls),
      { protected: ['infra/**'] },
    );
    expect(b.asked[0]).toMatchObject({
      category: 'protected',
      tool: 'file',
      command: 'write infra/prod.tf',
      argv: ['write', 'infra/prod.tf'],
    });
    expect(existsSync(join(b.ws, 'infra/prod.tf'))).toBe(true);
    expect(b.asked).toHaveLength(1);
  });
  it('a symlink inside the workspace does not get around a protected glob', async () => {
    const a = await setup(
      { permissions: { protected: ['infra/**'] } },
      finishAfter([{ name: 'write_file', args: { path: 'x/main.tf', content: 'x' } }]),
      {
        before: (ws) => {
          mkdirSync(join(ws, 'infra'));
          symlinkSync(join(ws, 'infra'), join(ws, 'x'));
        },
      },
    );
    expect(a.result('write_file')).toMatch(/protected/);
    expect(existsSync(join(a.ws, 'infra', 'main.tf'))).toBe(false);
  });
});
