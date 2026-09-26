# Fase 2A — Daemon local: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** um daemon por utilizador que executa os runs, guarda o estado em `~/.shibaox/events.db`, mantém um inbox persistente de aprovações (nós `human` e pushes/deploys dentro de tasks Claude Code, com sessão bloqueada e retoma por `session_id`), notifica por macOS e Telegram, corre agendamentos, e expõe uma API local em socket Unix que o CLI passa a consumir como cliente.

**Architecture:** `@shibaox/daemon` assenta no motor existente sem o alterar estruturalmente: o motor ganha `create`/`run` (fila), eventos novos (`RunStarted`, `SessionStarted`, `ToolApprovalRequested/Resolved`, `NodeSuspended`), uma `ApprovalHandler` que os adaptadores chamam e um `onRuntimeEvent` para o stream. O daemon é composto por `InboxService` (aprovações e humanos, promessas bloqueantes com timeout), `RunManager` (fila, concorrência, retoma no arranque, worktrees, notas do vault, autorouting, absorvendo o `wiring.ts` do CLI), `Server` (HTTP JSON + SSE sobre `node:http` num socket Unix), `DaemonClient`, canais (`macos`, `telegram`) com outbox, e `Scheduler` (croner). O CLI fica só com cliente e apresentação; `replay --db`, `init`, `doctor`, `models`, `providers`, `graph` e `worktree` continuam locais.

**Tech Stack:** TypeScript strict ESM/NodeNext, pnpm 10 + turborepo, vitest, biome, zod 4, better-sqlite3 13, `node:http` (socket Unix), `croner` (única dependência nova), `@anthropic-ai/claude-agent-sdk` (`resume`), Telegram Bot API por `fetch`.

**Spec:** `docs/superpowers/specs/2026-09-26-shibaox-2a-daemon-design.md` (complementa `2026-09-25-shibaox-design.md` §10).

## Global Constraints

- Node `>=22`; ESM com imports relativos `.js`; `pnpm build && pnpm test && pnpm lint` verdes (0 erros de lint; as 9 warnings `noNonNullAssertion` pré-existentes são aceites).
- Dependência nova permitida: só `croner`. HTTP com `node:http`, SSE à mão, Telegram por `fetch`.
- Socket `~/.shibaox/daemon.sock` com permissões `0600`; sem autenticação; `SHIBAOX_HOME` sobrepõe `~/.shibaox`.
- Só o daemon escreve no SQLite; o CLI só o abre em `replay --db` (offline).
- Nenhum segredo (chaves, tokens) em eventos, notas, logs ou mensagens de canal; os canais nunca enviam diffs, ficheiros ou saídas de ferramentas.
- Eventos são imutáveis e o replay determinístico: todo o estado deriva do log; campos novos são opcionais para os logs antigos continuarem a replayar.
- Aprovação vale para o comando exato: `argvHash` = SHA-256 hex do argv normalizado (`JSON.stringify(argv)`).
- Timeout de aprovação por defeito 120 minutos (`approval_timeout_minutes`); `max_concurrent_runs` 4 global, 2 por org.
- Testes reais só atrás de `SHIBAOX_REAL_TESTS=1`; nunca correr uma sessão Claude Code real nos testes normais.
- Todos os testes limpam diretórios temporários e sockets (`afterEach` com `rmSync(..., { recursive: true, force: true })`).
- Texto de CLI e canais: sentence case, verbo-primeiro, sem emoji, erro = o que aconteceu + o que fazer.
- Commits terminam com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **O daemon morre enquanto uma sessão Claude Code está bloqueada numa aprovação.** Ao reiniciar, o pedido continua no inbox, o nó fica suspenso, e responder retoma a sessão com `resume: sessionId`. Teste na Task 7 (`restart keeps the pending approval and resumes by session id`).
2. **Duas respostas ao mesmo pedido** (CLI e Telegram): a primeira ganha, a segunda recebe 409 e nada muda no log. Teste na Task 8 (`second answer gets 409`).
3. **Socket órfão** de um daemon morto: o novo daemon arranca e o CLI liga-se. Teste na Task 8 (`replaces a stale socket file`).
4. **Ctrl-C em `shibaox run`** não cancela nada: o cliente desliga-se do SSE e o run continua. Teste na Task 8 (`client disconnect does not cancel the run`).
5. **Callback do Telegram vindo de outro chat** é ignorado e registado; o pedido continua pendente. Teste na Task 9 (`ignores callbacks from other chats`).

---

## Estrutura de ficheiros

```
packages/schemas/src/events.ts            eventos novos, RunCreated.orgRoot
packages/schemas/src/org.ts               max_concurrent_runs
packages/core/src/run/state.ts            RunStatus, NodeState.sessionId/approvals, PendingApproval
packages/core/src/run/reducer.ts          eventos novos
packages/core/src/run/approvals.ts        ApprovalHandler, ApprovalRequest, argvHash, AutoApprove/Deny
packages/core/src/executors/types.ts      RuntimeEvent aditivo, AdapterErrorReason, TaskJob.resume*, ExecutionContext.onEvent
packages/core/src/run/engine.ts           create/run/suspend, approval_pending, SessionStarted, onRuntimeEvent
packages/core/src/events/store.ts         subscribe
packages/core/src/events/memory-store.ts  subscribe
packages/persistence-sqlite/src/index.ts  subscribe, SchedulesRepo, OutboxRepo
packages/adapter-claude-code/src/permissions.ts  ApprovalHandler, approvedCommands
packages/adapter-claude-code/src/adapter.ts      session, resume, ids/durations, parent_tool_use_id, timeout
packages/adapter-direct/src/tools.ts      approvals no run_command, ids/durations
packages/daemon/src/home.ts               caminhos SHIBAOX_HOME
packages/daemon/src/config.ts             daemon.yaml
packages/daemon/src/inbox.ts              InboxService
packages/daemon/src/runtime.ts            buildRuntime (movido do CLI)
packages/daemon/src/run-manager.ts        fila, concorrência, retoma, worktree, notas, graph
packages/daemon/src/runtime-buffer.ts     buffer circular de RuntimeEvents por run
packages/daemon/src/server.ts             HTTP + SSE
packages/daemon/src/client.ts             DaemonClient, ensureDaemon
packages/daemon/src/channels/{types,outbox,macos,telegram}.ts
packages/daemon/src/scheduler.ts          croner
packages/daemon/src/daemon.ts             classe Daemon (composição)
packages/daemon/src/index.ts
apps/cli/src/commands/{daemon,run,follow,inbox,schedule,resume,runs,replay,cancel}.ts
apps/cli/src/output.ts                    --json e impressão
```

---

### Task 1: Schemas, estado e reducer (eventos novos)

**Files:**
- Modify: `packages/schemas/src/events.ts`
- Modify: `packages/schemas/src/org.ts`
- Modify: `packages/core/src/run/state.ts`
- Modify: `packages/core/src/run/reducer.ts`
- Test: `packages/core/test/reducer-2a.test.ts`

**Interfaces:**
- Consumes: `RunEventSchema`, `RunState`, `reduce`/`replay` existentes.
- Produces: eventos `RunStarted`, `SessionStarted`, `ToolApprovalRequested`, `ToolApprovalResolved`, `NodeSuspended`; `RunCreated.orgRoot?`; `OrgSchema.max_concurrent_runs?`; `RunStatus` com `queued` e `waiting_approval`; `NodeState.sessionId?`, `NodeState.approvals`; `RunState.pendingApprovals: PendingApproval[]`, `RunState.orgRoot?`.

- [ ] **Step 1: Teste do reducer a falhar**

```ts
// packages/core/test/reducer-2a.test.ts
import { replay } from '../src/run/reducer.js';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@shibaox/schemas';

const at = '2026-09-26T00:00:00.000Z';
const created: RunEvent = {
  type: 'RunCreated', runId: 'r1', at, workflow: 'wf', input: {}, workspace: '/w', orgRoot: '/org',
};
const approvalReq: RunEvent = {
  type: 'ToolApprovalRequested', runId: 'r1', nodeId: 'impl', at, approvalId: 'a1', role: 'backend',
  tool: 'Bash', program: 'git', category: 'push', command: 'git push origin main', argvHash: 'h1',
};

describe('reducer phase 2A', () => {
  it('RunCreated is queued until RunStarted; a legacy NodeStarted also starts it', () => {
    expect(replay([created]).status).toBe('queued');
    expect(replay([created, { type: 'RunStarted', runId: 'r1', at }]).status).toBe('running');
    expect(replay([created, { type: 'NodeStarted', runId: 'r1', nodeId: 'a', at }]).status).toBe('running');
    expect(replay([created]).orgRoot).toBe('/org');
  });
  it('tool approval blocks the run and resolves back to running, recording it on the node', () => {
    const base = [created, { type: 'RunStarted', runId: 'r1', at } as RunEvent,
      { type: 'NodeStarted', runId: 'r1', nodeId: 'impl', at } as RunEvent];
    const waiting = replay([...base, approvalReq]);
    expect(waiting.status).toBe('waiting_approval');
    expect(waiting.pendingApprovals).toEqual([{
      approvalId: 'a1', runId: 'r1', nodeId: 'impl', role: 'backend', tool: 'Bash', program: 'git',
      category: 'push', command: 'git push origin main', argvHash: 'h1', at,
    }]);
    const resolved = replay([...base, approvalReq,
      { type: 'ToolApprovalResolved', runId: 'r1', nodeId: 'impl', at, approvalId: 'a1', approved: true, via: 'cli' }]);
    expect(resolved.status).toBe('running');
    expect(resolved.pendingApprovals).toEqual([]);
    expect(resolved.nodes.impl?.approvals).toEqual({
      a1: { argvHash: 'h1', command: 'git push origin main', approved: true, note: undefined },
    });
  });
  it('SessionStarted records the session id; NodeSuspended makes the node re-runnable and keeps waiting_approval', () => {
    const s = replay([created, { type: 'RunStarted', runId: 'r1', at },
      { type: 'NodeStarted', runId: 'r1', nodeId: 'impl', at },
      { type: 'SessionStarted', runId: 'r1', nodeId: 'impl', at, runtime: 'claude-code', sessionId: 'sess-1' },
      approvalReq,
      { type: 'NodeSuspended', runId: 'r1', nodeId: 'impl', at, sessionId: 'sess-1', approvalId: 'a1' }]);
    expect(s.status).toBe('waiting_approval');
    expect(s.nodes.impl).toMatchObject({ status: 'pending', sessionId: 'sess-1', attempts: 1 });
    expect(s.nodes.impl?.startedIdx).toBeUndefined();
  });
  it('resolving while a human is also pending goes back to waiting_human', () => {
    const s = replay([created, { type: 'RunStarted', runId: 'r1', at },
      { type: 'HumanRequested', runId: 'r1', nodeId: 'ship', at, action: 'ship', prompt: 'ok?' },
      approvalReq,
      { type: 'ToolApprovalResolved', runId: 'r1', nodeId: 'impl', at, approvalId: 'a1', approved: false, note: 'no', via: 'telegram' }]);
    expect(s.status).toBe('waiting_human');
  });
  it('a denied approval stays recorded so the adapter can deny without asking again', () => {
    const s = replay([created, { type: 'RunStarted', runId: 'r1', at }, approvalReq,
      { type: 'ToolApprovalResolved', runId: 'r1', nodeId: 'impl', at, approvalId: 'a1', approved: false, via: 'api' }]);
    expect(s.nodes.impl?.approvals.a1?.approved).toBe(false);
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `pnpm --filter @shibaox/core exec vitest run test/reducer-2a.test.ts`
Expected: FAIL (schema rejects `RunStarted`; `orgRoot`/`pendingApprovals` undefined).

- [ ] **Step 3: Schemas**

Em `packages/schemas/src/events.ts`, dentro do `discriminatedUnion`, acrescentar a `RunCreated`:

```ts
    /** The org directory the run was submitted with (recorded since phase 2A). */
    orgRoot: z.string().optional(),
```

e os eventos novos (depois de `RunCreated`):

```ts
  z.object({ ...base, type: z.literal('RunStarted') }),
  z.object({
    ...node,
    type: z.literal('SessionStarted'),
    runtime: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    ...node,
    type: z.literal('ToolApprovalRequested'),
    approvalId: z.string(),
    role: z.string(),
    tool: z.literal('Bash'),
    program: z.string(),
    category: z.enum(['push', 'deploy']),
    command: z.string(),
    argvHash: z.string(),
  }),
  z.object({
    ...node,
    type: z.literal('ToolApprovalResolved'),
    approvalId: z.string(),
    approved: z.boolean(),
    note: z.string().optional(),
    via: z.enum(['cli', 'telegram', 'api', 'auto']),
  }),
  z.object({
    ...node,
    type: z.literal('NodeSuspended'),
    sessionId: z.string().optional(),
    approvalId: z.string(),
    /** What the suspended attempt cost (counted by the reducer like any other cost). */
    cost: CostSchema.optional(),
  }),
```

Em `packages/schemas/src/org.ts`, no objeto de `org.yaml` (ao lado de `adapter`):

```ts
  /** Runs of this org that may execute at once in the daemon (default 2). */
  max_concurrent_runs: z.number().int().positive().optional(),
```

- [ ] **Step 4: Estado**

`packages/core/src/run/state.ts`:

```ts
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_human'
  | 'waiting_approval'
  | 'paused_budget'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface NodeApproval {
  argvHash: string;
  command: string;
  approved?: boolean;
  note?: string;
}

export interface NodeState {
  // ...campos existentes...
  /** Runtime session of the latest attempt (Claude Code `session_id`), for resume. */
  sessionId?: string;
  /** Tool approvals asked during this node, by approvalId (pending ones have no `approved`). */
  approvals: Record<string, NodeApproval>;
}

export interface PendingApproval {
  approvalId: string;
  runId: string;
  nodeId: string;
  role: string;
  tool: 'Bash';
  program: string;
  category: 'push' | 'deploy';
  command: string;
  argvHash: string;
  at: string;
}

export interface RunState {
  // ...campos existentes...
  orgRoot?: string;
  pendingApprovals: PendingApproval[];
}
```

`nodeOf` no reducer passa a devolver `{ status: 'pending', attempts: 0, approvals: {} }`.

- [ ] **Step 5: Reducer**

Em `reduce`, no ramo `RunCreated`: `status: 'queued'`, `orgRoot: event.orgRoot`, `pendingApprovals: []`. Em `applyEvent`:

```ts
    case 'RunStarted':
      return s.status === 'queued' ? { ...s, status: 'running' } : s;
    case 'NodeStarted': {
      const started = withNode(s, event.nodeId, { /* como hoje */ });
      return started.status === 'queued' ? { ...started, status: 'running' } : started;
    }
    case 'SessionStarted':
      return withNode(s, event.nodeId, { sessionId: event.sessionId });
    case 'ToolApprovalRequested': {
      const n = nodeOf(s, event.nodeId);
      const pending: PendingApproval = {
        approvalId: event.approvalId, runId: event.runId, nodeId: event.nodeId, role: event.role,
        tool: event.tool, program: event.program, category: event.category, command: event.command,
        argvHash: event.argvHash, at: event.at,
      };
      return {
        ...withNode(s, event.nodeId, {
          approvals: { ...n.approvals, [event.approvalId]: { argvHash: event.argvHash, command: event.command } },
        }),
        status: s.status === 'running' ? 'waiting_approval' : s.status,
        pendingApprovals: [...s.pendingApprovals.filter((p) => p.approvalId !== event.approvalId), pending],
      };
    }
    case 'ToolApprovalResolved': {
      const n = nodeOf(s, event.nodeId);
      const prev = n.approvals[event.approvalId];
      const pendingApprovals = s.pendingApprovals.filter((p) => p.approvalId !== event.approvalId);
      const next = withNode(s, event.nodeId, {
        approvals: {
          ...n.approvals,
          [event.approvalId]: { argvHash: prev?.argvHash ?? '', command: prev?.command ?? '', approved: event.approved, note: event.note },
        },
      });
      const status: RunStatus =
        s.status !== 'waiting_approval' ? s.status
        : pendingApprovals.length > 0 ? 'waiting_approval'
        : s.pendingHumans.length > 0 ? 'waiting_human'
        : 'running';
      return { ...next, pendingApprovals, status };
    }
    case 'NodeSuspended': {
      const { startedIdx: _startedIdx, ...rest } = nodeOf(s, event.nodeId);
      return {
        ...s,
        nodes: { ...s.nodes, [event.nodeId]: { ...rest, status: 'pending', sessionId: event.sessionId ?? rest.sessionId } },
      };
    }
```

`HumanRequested` passa a só mudar o status para `waiting_human` quando `s.status === 'running'` (se está `waiting_approval`, mantém; a resolução da aprovação vai olhar para `pendingHumans`). Em `HumanResponded` aprovado: `status: pendingHumans.length > 0 ? 'waiting_human' : s.pendingApprovals.length > 0 ? 'waiting_approval' : 'running'`. Runs terminais continuam a limpar `pendingHumans` e também `pendingApprovals`.

- [ ] **Step 6: Correr tudo**

Run: `pnpm build && pnpm test`
Expected: PASS. Testes existentes que esperam `status: 'running'` logo após `RunCreated` (procurar em `packages/core/test` e `apps/cli/test`) passam a esperar `queued` só quando replayam `[RunCreated]` isolado; os que replayam logs com `NodeStarted` continuam iguais.

- [ ] **Step 7: Commit**

```bash
git add packages/schemas packages/core
git commit -m "feat(core): queued/waiting_approval states, tool approval and session events

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Motor: `create`/`run`/`suspend`, aprovações, sessões e stream

**Files:**
- Create: `packages/core/src/run/approvals.ts`
- Modify: `packages/core/src/executors/types.ts`
- Modify: `packages/core/src/run/engine.ts`
- Modify: `packages/core/src/events/store.ts`, `packages/core/src/events/memory-store.ts`
- Modify: `packages/core/src/index.ts` (exportar `approvals.ts`)
- Test: `packages/core/test/engine-2a.test.ts`

**Interfaces:**
- Consumes: eventos e estado da Task 1.
- Produces:

```ts
// packages/core/src/run/approvals.ts
export interface ApprovalRequest {
  runId: string; nodeId: string; role: string; tool: 'Bash';
  program: string; category: 'push' | 'deploy'; command: string; argv: string[];
}
export type ApprovalAnswer =
  | { approved: boolean; note?: string }
  | { deferred: true; approvalId: string };
export interface ApprovalHandler {
  request(req: ApprovalRequest, opts: { signal?: AbortSignal }): Promise<ApprovalAnswer>;
}
export function argvHash(argv: string[]): string;         // sha256 hex of JSON.stringify(argv)
export class AutoApproveApprovals implements ApprovalHandler {}  // { approved: true, note: 'auto-approved' }
export class DenyApprovals implements ApprovalHandler {}         // { approved: false, note: 'approvals are disabled' }

// executors/types.ts (aditivo)
export type AdapterErrorReason = 'budget_exceeded' | 'approval_pending';
export type RuntimeEvent =
  | { type: 'started' }
  | { type: 'session'; runtime: string; sessionId: string }
  | { type: 'text'; text: string; parentToolUseId?: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown; parentToolUseId?: string }
  | { type: 'tool_result'; id?: string; name: string; output: unknown; durationMs?: number; parentToolUseId?: string }
  | { type: 'file_changed'; path: string }
  | { type: 'result'; output: unknown; summary: string; cost?: Cost }
  | { type: 'error'; message: string; cost?: Cost; reason?: AdapterErrorReason; approvalId?: string };
export interface TaskJob {
  // ...existente...
  /** Runtime session to resume (set when the node was suspended with a session id). */
  resumeSessionId?: string;
  /** What to tell the resumed session (which approval was granted/denied). */
  resumeNote?: string;
  /** argvHash → approved, for approvals already answered on this node. */
  approvedCommands: Record<string, boolean>;
}
export interface ExecutionContext {
  signal: AbortSignal;
  log: (line: string) => void;
  /** Every RuntimeEvent the adapter yields (for streaming); optional. */
  onEvent?: (e: RuntimeEvent) => void;
}
export class AdapterError { constructor(message, cost?, reason?, readonly approvalId?: string) }

// engine.ts
export interface EngineDeps {
  // ...existente...
  approvals?: ApprovalHandler;              // exposto aos adaptadores via EngineDeps para wiring, não usado pelo motor
  onRuntimeEvent?: (runId: string, nodeId: string, e: RuntimeEvent) => void;
}
class RunEngine {
  create(opts: StartOptions): Promise<string>;         // emite RunCreated → queued, devolve runId
  run(runId: string): Promise<RunState>;               // queued → RunStarted + drive; running → drive interrupted; outro → devolve estado
  start(opts): Promise<RunState>;                      // create + run
  suspend(runId: string): Promise<RunState>;           // emite NodeSuspended para cada nó running de um run waiting_approval
  resume(runId, opts): Promise<RunState>;              // waiting_approval com pendentes → throw "answer the pending approval first"
}
// StartOptions = opções atuais de start + orgRoot?: string
// EventStore
export interface EventStore {
  append(event): Promise<StoredEvent>;
  read(runId): Promise<StoredEvent[]>;
  listRuns(): Promise<RunSummary[]>;
  subscribe(listener: (e: StoredEvent) => void): () => void;   // unsubscribe
}
```

- [ ] **Step 1: Testes do motor a falhar**

```ts
// packages/core/test/engine-2a.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryEventStore } from '../src/events/memory-store.js';
import { AdapterError, type RuntimeAdapter, type RuntimeEvent } from '../src/executors/types.js';
import { RunEngine } from '../src/run/engine.js';
import { AutoApproveHuman, ScriptedDecider } from '../src/run/deciders.js';
import { orgWithTask } from './helpers.js'; // existing helper that builds an Org with one task workflow 'wf' → node 'impl' (create it if absent: see packages/core/test/engine.test.ts for the org fixture)

function adapter(script: (job: Parameters<RuntimeAdapter['run']>[0]) => RuntimeEvent[]): RuntimeAdapter {
  return {
    id: 'fake',
    capabilities: () => ['shell'],
    async *run(job) { for (const e of script(job)) yield e; },
  };
}
const deps = (store: MemoryEventStore, a: RuntimeAdapter, extra = {}) => ({
  store, org: orgWithTask('fake'), adapters: { fake: a }, defaultAdapter: 'fake',
  decider: new ScriptedDecider({}, 'ship'), human: new AutoApproveHuman(), ...extra,
});

describe('engine phase 2A', () => {
  it('create queues; run starts and completes', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(deps(store, adapter(() => [{ type: 'result', output: 1, summary: 'ok' }])));
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w', orgRoot: '/org' });
    expect((await engine.state(runId)).status).toBe('queued');
    const state = await engine.run(runId);
    expect(state.status).toBe('completed');
    const types = (await store.read(runId)).map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(['RunCreated', 'RunStarted', 'NodeStarted']);
  });
  it('approval_pending suspends the node with its session id instead of failing', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(deps(store, adapter(() => [
      { type: 'session', runtime: 'claude-code', sessionId: 'sess-9' },
      { type: 'error', message: 'approval pending', reason: 'approval_pending', approvalId: 'a1', cost: { usd: 0.1, inputTokens: 1, outputTokens: 1 } },
    ])));
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    // the approval request itself is appended by the inbox (daemon); simulate it here
    await store.append({ type: 'ToolApprovalRequested', runId, nodeId: 'impl', at: 'x', approvalId: 'a1', role: 'r', tool: 'Bash', program: 'git', category: 'push', command: 'git push', argvHash: 'h' });
    const state = await engine.run(runId);
    expect(state.status).toBe('waiting_approval');
    expect(state.nodes.impl).toMatchObject({ status: 'pending', sessionId: 'sess-9', attempts: 1 });
    expect(state.spentUsd).toBeCloseTo(0.1);
    expect((await store.read(runId)).some((e) => e.type === 'SessionStarted')).toBe(true);
    expect((await store.read(runId)).some((e) => e.type === 'NodeFailed')).toBe(false);
  });
  it('resume after the approval is resolved re-runs the node with resumeSessionId, resumeNote and approvedCommands', async () => {
    const store = new MemoryEventStore();
    const jobs: unknown[] = [];
    let calls = 0;
    const engine = new RunEngine(deps(store, adapter((job) => {
      jobs.push(job);
      return ++calls === 1
        ? [{ type: 'session', runtime: 'claude-code', sessionId: 's1' }, { type: 'error', message: 'p', reason: 'approval_pending', approvalId: 'a1' }]
        : [{ type: 'result', output: 1, summary: 'done' }];
    })));
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    await store.append({ type: 'ToolApprovalRequested', runId, nodeId: 'impl', at: 'x', approvalId: 'a1', role: 'r', tool: 'Bash', program: 'git', category: 'push', command: 'git push origin main', argvHash: 'h1' });
    await engine.run(runId);
    await expect(engine.resume(runId)).rejects.toThrow('answer the pending approval first');
    await store.append({ type: 'ToolApprovalResolved', runId, nodeId: 'impl', at: 'y', approvalId: 'a1', approved: true, via: 'cli' });
    const state = await engine.resume(runId);
    expect(state.status).toBe('completed');
    expect(jobs[1]).toMatchObject({
      resumeSessionId: 's1',
      resumeNote: 'The approval for `git push origin main` was granted. Continue the task.',
      approvedCommands: { h1: true },
    });
  });
  it('suspend marks running nodes of a waiting_approval run as re-runnable', async () => {
    const store = new MemoryEventStore();
    const engine = new RunEngine(deps(store, adapter(() => [])));
    const runId = await engine.create({ workflow: 'wf', input: {}, workspace: '/w' });
    await store.append({ type: 'RunStarted', runId, at: 'x' });
    await store.append({ type: 'NodeStarted', runId, nodeId: 'impl', at: 'x' });
    await store.append({ type: 'SessionStarted', runId, nodeId: 'impl', at: 'x', runtime: 'claude-code', sessionId: 's1' });
    await store.append({ type: 'ToolApprovalRequested', runId, nodeId: 'impl', at: 'x', approvalId: 'a1', role: 'r', tool: 'Bash', program: 'git', category: 'push', command: 'git push', argvHash: 'h' });
    const state = await engine.suspend(runId);
    expect(state.nodes.impl).toMatchObject({ status: 'pending', sessionId: 's1' });
    expect((await store.read(runId)).at(-1)).toMatchObject({ type: 'NodeSuspended', approvalId: 'a1', sessionId: 's1' });
  });
  it('streams runtime events through onRuntimeEvent and the store notifies subscribers', async () => {
    const store = new MemoryEventStore();
    const seen: string[] = [];
    const stored: string[] = [];
    const off = store.subscribe((e) => stored.push(e.type));
    const engine = new RunEngine(deps(store, adapter(() => [
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_result', id: 't1', name: 'Bash', output: 'ok', durationMs: 5 },
      { type: 'result', output: 1, summary: 'ok' },
    ]), { onRuntimeEvent: (_r: string, _n: string, e: RuntimeEvent) => seen.push(e.type) }));
    await engine.start({ workflow: 'wf', input: {}, workspace: '/w' });
    expect(seen).toEqual(['tool_use', 'tool_result', 'result']);
    expect(stored).toContain('RunCompleted');
    off();
  });
});
```

- [ ] **Step 2: Correr e ver falhar**

Run: `pnpm --filter @shibaox/core exec vitest run test/engine-2a.test.ts`
Expected: FAIL (`create` is not a function).

- [ ] **Step 3: `approvals.ts`**

```ts
import { createHash } from 'node:crypto';

export interface ApprovalRequest {
  runId: string;
  nodeId: string;
  role: string;
  tool: 'Bash';
  program: string;
  category: 'push' | 'deploy';
  command: string;
  argv: string[];
}
export type ApprovalAnswer =
  | { approved: boolean; note?: string }
  | { deferred: true; approvalId: string };
export interface ApprovalHandler {
  request(req: ApprovalRequest, opts: { signal?: AbortSignal }): Promise<ApprovalAnswer>;
}
export const argvHash = (argv: string[]): string =>
  createHash('sha256').update(JSON.stringify(argv)).digest('hex');
export class AutoApproveApprovals implements ApprovalHandler {
  async request(): Promise<ApprovalAnswer> { return { approved: true, note: 'auto-approved' }; }
}
export class DenyApprovals implements ApprovalHandler {
  async request(): Promise<ApprovalAnswer> { return { approved: false, note: 'approvals are disabled' }; }
}
```

- [ ] **Step 4: `types.ts`**

Aplicar as alterações do bloco Interfaces. `collectRun` chama `ctx.onEvent?.(event)` para todos os eventos antes de os tratar, e lança `new AdapterError(event.message, event.cost, event.reason, event.approvalId)` no `error`.

- [ ] **Step 5: `store.ts` e `memory-store.ts`**

`EventStore.subscribe`. Na memória: `private listeners = new Set<(e: StoredEvent) => void>()`; `append` chama cada listener depois de guardar (dentro de `try/catch` por listener: um listener que lança não parte o append); `subscribe` devolve `() => this.listeners.delete(l)`.

- [ ] **Step 6: Motor**

Em `engine.ts`:

```ts
export interface StartOptions {
  workflow: string; input: Record<string, unknown>; workspace: string; budgetUsd?: number;
  adapter?: string; workspaceMode?: 'inplace' | 'worktree'; project?: string; branch?: string; orgRoot?: string;
}

async create(opts: StartOptions): Promise<string> {
  const workflowSnapshot = this.resolveFromOrg(opts.workflow);
  const runId = (this.deps.newRunId ?? randomUUID)();
  await this.emit({ type: 'RunCreated', runId, at: this.now(), ...campos como hoje..., orgRoot: opts.orgRoot });
  return runId;
}
async run(runId: string): Promise<RunState> {
  const state = await this.state(runId);
  if (state.status === 'queued') {
    await this.emit({ type: 'RunStarted', runId, at: this.now() });
    return this.drive(runId);
  }
  if (state.status === 'running') return this.drive(runId, { interrupted: true });
  return state;
}
async start(opts: StartOptions): Promise<RunState> { return this.run(await this.create(opts)); }
async suspend(runId: string): Promise<RunState> {
  const state = await this.state(runId);
  const approvalId = state.pendingApprovals[0]?.approvalId;
  if (state.status !== 'waiting_approval' || !approvalId) return state;
  for (const [nodeId, n] of Object.entries(state.nodes))
    if (n.status === 'running')
      await this.emit({ type: 'NodeSuspended', runId, nodeId, at: this.now(), sessionId: n.sessionId, approvalId: state.pendingApprovals.find((p) => p.nodeId === nodeId)?.approvalId ?? approvalId });
  return this.state(runId);
}
```

Em `resume`: antes dos ramos existentes,

```ts
if (state.status === 'waiting_approval') {
  if (state.pendingApprovals.length > 0) {
    const p = state.pendingApprovals[0] as PendingApproval;
    throw new Error(`run ${runId} is waiting for an approval: answer the pending approval first (shibaox approve approval:${p.approvalId})`);
  }
}
```

e o `else if (state.status !== 'running') return state;` passa a aceitar também `waiting_approval` sem pendentes (não acontece pelo reducer, mas fica explícito): `else if (state.status !== 'running' && state.status !== 'queued') return state;` com `queued` a emitir `RunStarted` antes de `drive`.

Em `executeNode`, caso `task`: construir o job com

```ts
const nodeState = state.nodes[nodeId];
const resolved = Object.values(nodeState?.approvals ?? {}).filter((a) => a.approved !== undefined);
const last = resolved.at(-1);
const job: TaskJob = {
  ...como hoje...,
  approvedCommands: Object.fromEntries(resolved.map((a) => [a.argvHash, a.approved as boolean])),
  resumeSessionId: nodeState?.status === 'pending' && nodeState.sessionId ? nodeState.sessionId : undefined,
  resumeNote: last && nodeState?.sessionId
    ? `The approval for \`${last.command}\` was ${last.approved ? 'granted' : 'denied'}${last.note ? ` (${last.note})` : ''}. Continue the task.`
    : undefined,
};
```

Nota: `resumeSessionId` só quando o nó tem `sessionId` (foi suspenso ou correu antes); um nó a arrancar pela primeira vez não tem. O `resumeNote` sem `resumeSessionId` é anexado ao `instruction` pelo adaptador (não pelo motor).

`collectRun(adapter, job, { signal, log, onEvent: (e) => { this.deps.onRuntimeEvent?.(runId, nodeId, e); if (e.type === 'session') void this.emit({ type: 'SessionStarted', runId, nodeId, at: at(), runtime: e.runtime, sessionId: e.sessionId }); } })`. Para manter a ordem dos eventos determinística, o `SessionStarted` deve ser aguardado: acumular a promessa numa variável `pendingEmits: Promise<void>[]` e `await Promise.all(pendingEmits)` antes de emitir `NodeCompleted`/`NodeFailed`/`NodeSuspended`.

No `catch`, antes do ramo `budget_exceeded`:

```ts
if (e instanceof AdapterError && e.reason === 'approval_pending') {
  const now = await this.state(runId);
  const approvalId = e.approvalId ?? now.pendingApprovals.find((p) => p.nodeId === nodeId)?.approvalId;
  if (approvalId) {
    await this.emit({ type: 'NodeSuspended', runId, nodeId, at: at(), sessionId: now.nodes[nodeId]?.sessionId, approvalId, ...(e.cost ? { cost: e.cost } : {}) });
    return;
  }
}
```

`drive`: `if (state.status !== 'running')` mantém-se; `waiting_approval` sai do loop e o daemon volta a chamar `resume` quando o pedido for resolvido.

- [ ] **Step 7: Correr**

Run: `pnpm build && pnpm test`
Expected: PASS (adaptar `SqliteEventStore` provisoriamente com `subscribe` que lança `not implemented`? Não: implementar já a versão simples em memória de listeners no SQLite, a Task 3 completa-a).

- [ ] **Step 8: Commit**

```bash
git add packages/core packages/persistence-sqlite
git commit -m "feat(core): engine create/run/suspend, approval handler, session and runtime event streaming

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: SQLite: subscribe, `schedules` e `channel_outbox`

**Files:**
- Modify: `packages/persistence-sqlite/src/index.ts`
- Create: `packages/persistence-sqlite/src/schedules.ts`, `packages/persistence-sqlite/src/outbox.ts`
- Test: `packages/persistence-sqlite/test/repos.test.ts`

**Interfaces:**
- Produces:

```ts
export class SqliteEventStore implements EventStore {
  constructor(path: string);
  readonly db: Database.Database;          // partilhada pelos repositórios
  subscribe(listener): () => void;
  close(): void;
}
export interface ScheduleRow {
  id: string; cron: string; orgRoot: string; project: string; workflow: string; input: string;
  adapter?: string; budgetUsd?: number; enabled: boolean; lastRunId?: string; createdAt: string;
}
export class SchedulesRepo {
  constructor(db: Database.Database);      // CREATE TABLE IF NOT EXISTS schedules(...)
  list(): ScheduleRow[]; get(id): ScheduleRow | undefined;
  add(row: Omit<ScheduleRow, 'id' | 'createdAt'> & { id?: string }): ScheduleRow;
  remove(id): boolean; setLastRun(id, runId): void; setEnabled(id, enabled): void;
}
export interface OutboxRow {
  id: number; channel: string; inboxId: string; payload: string; attempts: number; nextAt: string;
}
export class OutboxRepo {
  constructor(db: Database.Database);      // CREATE TABLE IF NOT EXISTS channel_outbox(...)
  enqueue(channel: string, inboxId: string, payload: unknown): OutboxRow;
  due(now: string): OutboxRow[];           // nextAt <= now, ordered by id
  retry(id: number, nextAt: string): void; // attempts+1
  remove(id: number): void; removeForInbox(inboxId: string): void;
}
```

- [ ] **Step 1: Teste a falhar**

```ts
// packages/persistence-sqlite/test/repos.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OutboxRepo, SchedulesRepo, SqliteEventStore } from '../src/index.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('sqlite repos', () => {
  it('subscribe receives appended events and unsubscribes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const seen: string[] = [];
    const off = store.subscribe((e) => seen.push(`${e.type}:${e.seq}`));
    await store.append({ type: 'RunCreated', runId: 'r', at: 'x', workflow: 'w', input: {}, workspace: '/w' });
    off();
    await store.append({ type: 'RunStarted', runId: 'r', at: 'x' });
    expect(seen).toEqual(['RunCreated:1']);
    store.close();
  });
  it('schedules and outbox round-trip', () => {
    dir = mkdtempSync(join(tmpdir(), 'shx-sql-'));
    const store = new SqliteEventStore(join(dir, 'e.db'));
    const schedules = new SchedulesRepo(store.db);
    const s = schedules.add({ cron: '0 9 * * 1-5', orgRoot: '/org', project: '/p', workflow: 'wf', input: 'hi', enabled: true });
    expect(schedules.list()).toHaveLength(1);
    schedules.setLastRun(s.id, 'run-1');
    expect(schedules.get(s.id)?.lastRunId).toBe('run-1');
    expect(schedules.remove(s.id)).toBe(true);
    const outbox = new OutboxRepo(store.db);
    const row = outbox.enqueue('telegram', 'approval:a1', { text: 'hi' });
    expect(outbox.due('2099-01-01T00:00:00.000Z')).toHaveLength(1);
    outbox.retry(row.id, '2099-01-02T00:00:00.000Z');
    expect(outbox.due('2099-01-01T00:00:00.000Z')).toHaveLength(0);
    outbox.removeForInbox('approval:a1');
    expect(outbox.due('2100-01-01T00:00:00.000Z')).toHaveLength(0);
    store.close();
  });
});
```

- [ ] **Step 2: Correr e ver falhar** — `pnpm --filter @shibaox/persistence-sqlite exec vitest run`.

- [ ] **Step 3: Implementar**

`SqliteEventStore`: `readonly db`; `private listeners = new Set<...>()`; em `append`, depois do `run`, `for (const l of this.listeners) try { l(stored) } catch {}`. `SchedulesRepo` e `OutboxRepo` com `CREATE TABLE IF NOT EXISTS` no construtor:

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, cron TEXT NOT NULL, org_root TEXT NOT NULL, project TEXT NOT NULL,
  workflow TEXT NOT NULL, input TEXT NOT NULL, adapter TEXT, budget_usd REAL,
  enabled INTEGER NOT NULL DEFAULT 1, last_run_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, inbox_id TEXT NOT NULL,
  payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS outbox_next ON channel_outbox(next_at);
```

`id` de schedule: `randomUUID().slice(0, 8)`. `enqueue` usa `nextAt = new Date().toISOString()`.

- [ ] **Step 4: Correr, exportar de `index.ts`, commit**

```bash
git add packages/persistence-sqlite
git commit -m "feat(sqlite): event subscriptions, schedules and channel outbox repos

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Adaptador Claude Code: aprovações bloqueantes, sessões, retoma, ids e subagentes

**Files:**
- Modify: `packages/adapter-claude-code/src/permissions.ts`
- Modify: `packages/adapter-claude-code/src/adapter.ts`
- Modify: `packages/adapter-claude-code/src/testing/fake-query.ts` (helpers `msg.toolUse` com `parent_tool_use_id`, `msg.session`)
- Test: `packages/adapter-claude-code/test/approvals.test.ts`

**Interfaces:**
- Consumes: `ApprovalHandler`, `ApprovalAnswer`, `argvHash` (core); `TaskJob.resumeSessionId/resumeNote/approvedCommands`; `RuntimeEvent` aditivo.
- Produces:

```ts
export interface ClaudeCodeAdapterOptions {
  // ...existente (human mantém-se para compatibilidade mas deixa de ser usado pelo canUseTool)...
  approvals: ApprovalHandler;
}
export interface CanUseToolArgs {
  role: Role; cwd: string; approvals: ApprovalHandler; runId: string; nodeId: string;
  log: (line: string) => void; approvedCommands: Record<string, boolean>; signal: AbortSignal;
  onDeferred?: (approvalId: string) => void;
}
```

Comportamento:
- `canUseTool` para push/deploy: `h = argvHash(argv)` (o `analyseBashCommand` passa a devolver `argv: string[]` no ramo `ok`); se `approvedCommands[h] === true` → allow; `=== false` → deny "already denied by the human"; senão `approvals.request({...}, { signal })`. Resposta `{approved}` → allow/deny. `{deferred, approvalId}` → `onDeferred(approvalId)` e `{ behavior: 'deny', message: APPROVAL_PENDING, interrupt: true }`.
- `run()`: `init` → `yield { type: 'session', runtime: 'claude-code', sessionId: m.session_id }` (o `SDKMessage` init tem `session_id`). `tool_use` → `id: block.id`, `parentToolUseId: m.parent_tool_use_id ?? undefined`; guarda `Date.now()` por id; `tool_result` → `id`, `durationMs`, `parentToolUseId`. `text` idem.
- `resumeSessionId` → `options.resume = job.resumeSessionId` e `prompt = job.resumeNote ?? 'Continue the task.'`; sem `resumeSessionId` mas com `resumeNote` → prompt normal com a nota anexada no fim.
- `deferred` → ao `result` (ou fim do stream), `yield { type: 'error', message, reason: 'approval_pending', approvalId, cost }`. Remover o texto antigo `pending()` sobre "approvals persisted".

- [ ] **Step 1: Testes a falhar**

```ts
// packages/adapter-claude-code/test/approvals.test.ts
import type { ApprovalHandler, ApprovalRequest } from '@shibaox/core';
import { argvHash } from '@shibaox/core';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/adapter.js';
import { fakeQuery, msg } from '../src/testing/fake-query.js';
import { role, run } from './helpers.js'; // helpers used by adapter.test.ts: role({tools, approval_required}) and run(adapter, jobPatch) collecting events

function handler(answer: (r: ApprovalRequest) => Promise<unknown>) {
  const requests: ApprovalRequest[] = [];
  const h: ApprovalHandler = { request: async (r) => { requests.push(r); return (await answer(r)) as never; } };
  return Object.assign(h, { requests });
}
const pushRole = role({ tools: ['git'], approval_required: ['push'] });

describe('claude-code approvals', () => {
  it('blocks canUseTool until the handler answers, then allows the push', async () => {
    let resolve!: (a: unknown) => void;
    const h = handler(() => new Promise((r) => { resolve = r; }));
    let decision: unknown;
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init({ session_id: 'sess-1' });
      const p = options.canUseTool!('Bash', { command: 'git push origin main' }, { signal: new AbortController().signal } as never);
      await new Promise((r) => setTimeout(r, 10));
      resolve({ approved: true, note: 'go' });
      decision = await p;
      yield msg.success('pushed');
    });
    const events = await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }), { role: pushRole });
    expect(decision).toMatchObject({ behavior: 'allow' });
    expect(h.requests[0]).toMatchObject({ program: 'git', category: 'push', command: 'git push origin main', argv: ['git', 'push', 'origin', 'main'] });
    expect(events.find((e) => e.type === 'session')).toEqual({ type: 'session', runtime: 'claude-code', sessionId: 'sess-1' });
  });
  it('uses approvedCommands without asking again, and denies an already denied command', async () => {
    const h = handler(async () => { throw new Error('must not be asked'); });
    const decisions: unknown[] = [];
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init();
      decisions.push(await options.canUseTool!('Bash', { command: 'git push origin main' }, {} as never));
      decisions.push(await options.canUseTool!('Bash', { command: 'git push origin dev' }, {} as never));
      yield msg.success('ok');
    });
    await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }), {
      role: pushRole,
      approvedCommands: { [argvHash(['git', 'push', 'origin', 'main'])]: true, [argvHash(['git', 'push', 'origin', 'dev'])]: false },
    });
    expect(decisions[0]).toMatchObject({ behavior: 'allow' });
    expect(decisions[1]).toMatchObject({ behavior: 'deny' });
  });
  it('a deferred answer interrupts and ends the task with approval_pending and the approval id', async () => {
    const h = handler(async () => ({ deferred: true, approvalId: 'a-42' }));
    const q = fakeQuery(async function* ({ options }) {
      yield msg.init({ session_id: 's' });
      const d = await options.canUseTool!('Bash', { command: 'git push' }, {} as never);
      expect(d).toMatchObject({ behavior: 'deny', interrupt: true });
      yield msg.error('error_during_execution', 0.2);
    });
    const events = await run(new ClaudeCodeAdapter({ approvals: h, queryFn: q }), { role: pushRole });
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'approval_pending', approvalId: 'a-42', cost: { usd: 0.2 } });
  });
  it('resumes a session with the note as the prompt', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('continued')]);
    await run(new ClaudeCodeAdapter({ approvals: handler(async () => ({ approved: true })), queryFn: q }), {
      role: pushRole, resumeSessionId: 'sess-1', resumeNote: 'The approval for `git push` was granted. Continue the task.',
    });
    expect(q.calls[0]?.options.resume).toBe('sess-1');
    expect(q.calls[0]?.prompt).toBe('The approval for `git push` was granted. Continue the task.');
  });
  it('maps tool ids, durations and parent tool use ids', async () => {
    const q = fakeQuery(() => [
      msg.init(),
      msg.toolUse('t1', 'Read', { file_path: 'a' }, { parent_tool_use_id: 'agent-1' }),
      msg.toolResult('t1', 'content', { parent_tool_use_id: 'agent-1' }),
      msg.success('ok'),
    ]);
    const events = await run(new ClaudeCodeAdapter({ approvals: handler(async () => ({ approved: true })), queryFn: q }), { role: role({ tools: ['read'] }) });
    expect(events.find((e) => e.type === 'tool_use')).toMatchObject({ id: 't1', parentToolUseId: 'agent-1' });
    const r = events.find((e) => e.type === 'tool_result') as { durationMs?: number; parentToolUseId?: string };
    expect(r.parentToolUseId).toBe('agent-1');
    expect(typeof r.durationMs).toBe('number');
  });
});
```

`msg.init` aceita `session_id`; `msg.toolUse(id, name, input, extra?)` e `msg.toolResult(id, content, extra?)` espalham `extra` no `SDKMessage` (para `parent_tool_use_id`).

- [ ] **Step 2: Correr e ver falhar**, **Step 3: implementar** conforme Interfaces/Comportamento, **Step 4: correr toda a suite do pacote** (`adapter.test.ts` e `permissions.test.ts` existentes: substituir `human` por `approvals: new AutoApproveApprovals()` / `DenyApprovals` onde o teste esperava `TerminalHuman`/`DeferHuman`; o teste "deferred approval → error" passa a esperar `reason: 'approval_pending'`), **Step 5: README** — secção Claude Code: "Approvals are answered from the inbox (CLI or Telegram); the session waits, and is resumed by session id if the daemon restarts or the approval times out."

- [ ] **Step 6: Commit**

```bash
git add packages/adapter-claude-code README.md
git commit -m "feat(adapter-claude-code): blocking tool approvals, session resume, tool ids and subagent tagging

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Adaptador direto: aprovações no `run_command`, ids e durações

**Files:**
- Modify: `packages/adapter-direct/src/tools.ts`, `packages/adapter-direct/src/adapter.ts`
- Test: `packages/adapter-direct/test/approvals.test.ts`

**Interfaces:**
- Consumes: `ApprovalHandler`, `argvHash`, `analyseBashCommand`? Não: o adaptador direto não depende do pacote claude-code. Classificação mínima própria: `program === 'git' && argv[1] === 'push'` → `push`; `program` em `{npm,pnpm,yarn}` com verbo em `{publish,unpublish,dist-tag,dist-tags,deprecate}`, ou `docker` com `push`/`--push`, ou qualquer programa de uma tabela `DEPLOY_PROGRAMS = ['vercel','fly','flyctl','netlify','heroku','railway','wrangler','kubectl','terraform','helm']` → `deploy`. (Duplicação aceite: a tabela completa é do Claude Code; este adaptador só tem os programas que `role.tools` lista.)
- Produces: `DirectAdapterOptions.approvals: ApprovalHandler`; `ToolArgs.approvals`, `ToolArgs.approvedCommands`, `ToolArgs.job`.

Comportamento no `run_command`, depois das verificações atuais e antes de `runArgv`: se a categoria é `push`/`deploy`: sem `approval_required` na role → erro "push requires approval_required in the role"; `approvedCommands[h]` decide; senão `approvals.request(...)`; `deferred` → lança `AdapterError('approval pending', undefined, 'approval_pending', approvalId)` que o `guarded` deixa passar (não converte em `{error}`) e o adaptador transforma em `{ type: 'error', reason: 'approval_pending', approvalId }` e termina o loop. `guarded` passa a emitir `tool_use` com `id: randomUUID()` e `tool_result` com o mesmo `id` e `durationMs`.

- [ ] **Step 1: Teste a falhar** (`packages/adapter-direct/test/approvals.test.ts`) com o servidor OpenAI-compatível falso já usado em `adapter.test.ts`: o modelo pede `run_command` `git push origin main`; (a) handler aprova → comando corre (usar `git` real num repo temporário sem remote é frágil: usar programa `echo` numa role com `tools: [echo]` e classificar `echo` como... não. Usar `git push` num repo temporário sem remote: falha com exit ≠ 0 mas **corre**, e o teste verifica que o handler foi chamado e o `tool_result` tem `exitCode` definido); (b) handler devolve `deferred` → último evento `error` com `reason: 'approval_pending'` e `approvalId`; (c) `approvedCommands` com hash aprovado → handler não é chamado.

- [ ] **Step 2–4:** correr, implementar, correr o pacote todo (os testes existentes passam `approvals: new AutoApproveApprovals()`).

- [ ] **Step 5: Commit**

```bash
git add packages/adapter-direct
git commit -m "feat(adapter-direct): approval-gated push/deploy commands, tool ids and durations

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Pacote daemon: home, config e `InboxService`

**Files:**
- Create: `packages/daemon/package.json`, `tsconfig.json`, `vitest.config.ts` (copiar de `packages/memory`), `src/index.ts`
- Create: `packages/daemon/src/home.ts`, `src/config.ts`, `src/inbox.ts`
- Test: `packages/daemon/test/inbox.test.ts`, `test/config.test.ts`

**Interfaces:**
- Produces:

```ts
// home.ts
export interface HomePaths { root: string; socket: string; pid: string; log: string; config: string; db: string }
export function homePaths(env: NodeJS.ProcessEnv = process.env): HomePaths; // SHIBAOX_HOME ?? ~/.shibaox; mkdir -p root (0700)

// config.ts (zod)
export const DaemonConfigSchema = z.object({
  max_concurrent_runs: z.number().int().positive().default(4),
  approval_timeout_minutes: z.number().positive().default(120),
  channels: z.object({
    macos: z.object({ enabled: z.boolean().default(true) }).default({}),
    telegram: z.object({ bot_token_env: z.string().default('SHIBAOX_TELEGRAM_TOKEN'), chat_id: z.number().int() }).optional(),
  }).default({}),
});
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export function loadDaemonConfig(path: string): DaemonConfig; // ficheiro ausente → defaults

// inbox.ts
export type InboxId = `human:${string}:${string}` | `approval:${string}`;
export interface InboxItem {
  id: InboxId; kind: 'human' | 'approval'; runId: string; nodeId: string; at: string;
  prompt: string;                          // human: prompt; approval: command
  detail: { action?: string; role?: string; program?: string; category?: 'push' | 'deploy' };
}
export type InboxAnswer = { approved: boolean; note?: string; via: 'cli' | 'telegram' | 'api' };
export interface InboxServiceOptions {
  store: EventStore; now?: () => string; approvalTimeoutMs: number; newId?: () => string;
  onItem?: (item: InboxItem) => void;      // canais
  onResolved?: (item: InboxItem, answer: InboxAnswer) => void;
}
export class InboxService implements ApprovalHandler, HumanHandler {
  constructor(opts: InboxServiceOptions);
  request(req: ApprovalRequest, opts: { signal?: AbortSignal }): Promise<ApprovalAnswer>;
  ask(req: HumanRequest): Promise<HumanAnswer>;         // emite nada (o motor já emitiu HumanRequested), devolve { deferred: true } e chama onItem
  list(): Promise<InboxItem[]>;                          // deriva do store: replay de cada run não terminal
  answer(id: InboxId, a: InboxAnswer): Promise<{ runId: string; kind: 'human' | 'approval' }>;
  // human: emite HumanResponded; approval: emite ToolApprovalResolved e resolve a promessa bloqueada (se existir)
  // erros: NotFoundError (404), AlreadyResolvedError (409)
  hasBlocked(approvalId: string): boolean;
}
export class NotFoundError extends Error {}
export class AlreadyResolvedError extends Error {}
```

`request`: gera `approvalId = newId()`, emite `ToolApprovalRequested` (com `argvHash(req.argv)`), chama `onItem`, regista `{ resolve }` num `Map<approvalId, ...>`, e devolve uma promessa que resolve com `{approved, note}` ao `answer`, ou `{ deferred: true, approvalId }` ao fim de `approvalTimeoutMs` (timer `unref()`), ou ao `signal` abortar (`deferred` também; o pedido fica pendente no log). `answer` de uma aprovação sem promessa bloqueada (daemon reiniciou) só emite o evento e chama `onResolved`; o `RunManager` (Task 7) é quem retoma o run.

- [ ] **Step 1: Testes a falhar**

```ts
// packages/daemon/test/inbox.test.ts
import { MemoryEventStore } from '@shibaox/core';
import { describe, expect, it, vi } from 'vitest';
import { AlreadyResolvedError, InboxService, NotFoundError } from '../src/inbox.js';

const req = { runId: 'r1', nodeId: 'impl', role: 'backend', tool: 'Bash' as const, program: 'git', category: 'push' as const, command: 'git push origin main', argv: ['git', 'push', 'origin', 'main'] };
async function seedRun(store: MemoryEventStore) {
  await store.append({ type: 'RunCreated', runId: 'r1', at: 'x', workflow: 'wf', input: {}, workspace: '/w' });
  await store.append({ type: 'RunStarted', runId: 'r1', at: 'x' });
  await store.append({ type: 'NodeStarted', runId: 'r1', nodeId: 'impl', at: 'x' });
}

describe('InboxService', () => {
  it('request appends ToolApprovalRequested, lists it, and answer resolves the blocked promise', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    const items: unknown[] = [];
    const inbox = new InboxService({ store, approvalTimeoutMs: 60_000, newId: () => 'a1', onItem: (i) => items.push(i) });
    const p = inbox.request(req, {});
    expect(await inbox.list()).toMatchObject([{ id: 'approval:a1', kind: 'approval', prompt: 'git push origin main', detail: { program: 'git', category: 'push', role: 'backend' } }]);
    expect(items).toHaveLength(1);
    await inbox.answer('approval:a1', { approved: true, note: 'ok', via: 'cli' });
    expect(await p).toEqual({ approved: true, note: 'ok' });
    expect((await store.read('r1')).at(-1)).toMatchObject({ type: 'ToolApprovalResolved', approvalId: 'a1', approved: true, via: 'cli' });
    expect(await inbox.list()).toEqual([]);
  });
  it('times out into deferred and keeps the item pending', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryEventStore();
      await seedRun(store);
      const inbox = new InboxService({ store, approvalTimeoutMs: 1000, newId: () => 'a1' });
      const p = inbox.request(req, {});
      vi.advanceTimersByTime(1001);
      expect(await p).toEqual({ deferred: true, approvalId: 'a1' });
      expect(await inbox.list()).toHaveLength(1);
      expect(inbox.hasBlocked('a1')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it('rejects unknown and already resolved ids', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000, newId: () => 'a1' });
    await expect(inbox.answer('approval:zz', { approved: true, via: 'api' })).rejects.toBeInstanceOf(NotFoundError);
    void inbox.request(req, {});
    await inbox.answer('approval:a1', { approved: false, via: 'telegram' });
    await expect(inbox.answer('approval:a1', { approved: true, via: 'cli' })).rejects.toBeInstanceOf(AlreadyResolvedError);
  });
  it('lists human nodes and answers them with HumanResponded', async () => {
    const store = new MemoryEventStore();
    await seedRun(store);
    await store.append({ type: 'HumanRequested', runId: 'r1', nodeId: 'ship', at: 'x', action: 'ship', prompt: 'Ship it?' });
    const inbox = new InboxService({ store, approvalTimeoutMs: 1000 });
    expect(await inbox.ask({ runId: 'r1', nodeId: 'ship', action: 'ship', prompt: 'Ship it?' })).toEqual({ deferred: true });
    expect(await inbox.list()).toMatchObject([{ id: 'human:r1:ship', kind: 'human', prompt: 'Ship it?' }]);
    expect(await inbox.answer('human:r1:ship', { approved: true, via: 'cli' })).toEqual({ runId: 'r1', kind: 'human' });
    expect((await store.read('r1')).at(-1)).toMatchObject({ type: 'HumanResponded', approved: true });
  });
});
```

`config.test.ts`: ficheiro ausente → defaults; YAML com `telegram: { chat_id: 5 }` → `bot_token_env` por defeito; `max_concurrent_runs: 0` → erro com o caminho do ficheiro na mensagem.

- [ ] **Step 2: Correr e ver falhar**, **Step 3: implementar** (`package.json` com dependências `@shibaox/core`, `@shibaox/schemas`, `@shibaox/persistence-sqlite`, `yaml`, `zod`; `list()` faz `store.listRuns()` e, para cada run não terminal, `replay(read)` → `pendingHumans` e `pendingApprovals`), **Step 4: correr**, **Step 5: commit**

```bash
git add packages/daemon pnpm-lock.yaml
git commit -m "feat(daemon): package scaffold, home paths, config and inbox service

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `RunManager`: runtime, fila, concorrência, retoma no arranque

**Files:**
- Create: `packages/daemon/src/runtime.ts` (mover `buildRuntime`, `effectiveAdapter`, `ADAPTER_IDS`, `isAdapterId`, `GraphWiring` de `apps/cli/src/wiring.ts`)
- Create: `packages/daemon/src/run-manager.ts` (mover de `apps/cli/src/commands/run.ts`: `prepareGraph`, `autoroute`, `finishRun`, `worktreeOf`, `projectOf`, `projectName`, `workspaceMode`, `gitPrefix`)
- Create: `packages/daemon/src/runtime-buffer.ts`
- Modify: `apps/cli/src/wiring.ts` → re-export de `@shibaox/daemon` (para os testes do CLI existentes até à Task 11)
- Test: `packages/daemon/test/run-manager.test.ts` (portar `apps/cli/test/run-e2e.test.ts` e `run-claude-code-e2e.test.ts` para aqui; apagar os originais nesta task)

**Interfaces:**
- Produces:

```ts
export interface SubmitRequest {
  orgRoot: string; project: string; workflow: string; input: string;
  adapter?: AdapterId; workspace?: WorkspaceMode; budgetUsd?: number;
}
export interface RunManagerOptions {
  store: EventStore; inbox: InboxService; config: DaemonConfig; log: (line: string) => void;
  env?: NodeJS.ProcessEnv; queryFn?: QueryFn; graphify?: Graphify; extraProviders?: ProviderEntry[];
  vault?: string; now?: () => string;
}
export interface RuntimeEnvelope { runId: string; nodeId: string; at: string; event: RuntimeEvent }
export class RunManager {
  constructor(opts: RunManagerOptions);
  submit(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }>;  // valida org/workflow/papéis, cria worktree, engine.create → queued, agenda
  start(): Promise<void>;      // retoma no arranque: queued/running → fila; waiting_approval sem processo → engine.suspend
  stop(opts: { force?: boolean; graceMs?: number }): Promise<void>;
  cancel(runId: string): Promise<RunState>;
  resume(runId: string, opts: { budgetUsd?: number }): Promise<RunState>;   // valida worktree existe; enfileira e devolve o estado após o run sair do loop
  state(runId: string): Promise<RunState>;
  list(filter?: { status?: RunStatus; orgRoot?: string }): Promise<RunSummaryPlus[]>;
  runtimeEvents(runId: string, since?: number): RuntimeEnvelope[];   // buffer circular 2000
  onRuntimeEvent(cb: (e: RuntimeEnvelope) => void): () => void;
  active(): { running: number; queued: number; waiting: number };
}
```

Regras internas:
- Uma `RunEngine` por run ativo, construída por `buildRuntime` a partir do org de `state.orgRoot` (recarregado do disco em cada arranque de run), com `human: inbox`, `approvals: inbox`, `onRuntimeEvent` → buffer + subscribers. Adaptadores recebem `approvals: inbox`.
- Fila FIFO de `runId`; `pump()` arranca runs enquanto `running < config.max_concurrent_runs` e `runningOfOrg(orgRoot) < (org.org.max_concurrent_runs ?? 2)`.
- Quando `engine.run`/`resume` devolve, o run saiu do loop: se terminal → `finishRun` (notas do vault) e remove do mapa; se `waiting_*`/`paused_budget` → remove do mapa (o motor não tem processo vivo); `pump()`.
- `inbox.onResolved` → se o run está em `waiting_approval` e não tem engine ativa (sessão caiu) ou o pedido era de um nó `human` → `resume(runId)`. Se tem engine ativa com promessa bloqueada, nada (o `canUseTool` continua).
- `start()`: para cada run de `store.listRuns()`: `queued` → fila; `running` → fila com `resume` (interrupted); `waiting_approval` → `engine.suspend(runId)` (nós `running` órfãos ficam `pending` com `sessionId`).
- `stop({force})`: sem force espera `graceMs` (60 s) pelas engines ativas, depois `cancel` nas restantes com razão "daemon stopped".

- [ ] **Step 1: Portar os testes e-2-e** para `packages/daemon/test/run-manager.test.ts` usando `RunManager` + `InboxService` + `MemoryEventStore` (setup: `scaffoldOrg` do CLI move-se para `packages/daemon/src/templates.ts`? Não: o `init` fica no CLI; os testes do daemon importam `scaffoldOrg` de `@shibaox/cli`? Ciclo. Decisão: mover `apps/cli/src/templates.ts` e `scaffoldOrg` para `packages/daemon/src/templates.ts`, exportado; o CLI `init` importa de `@shibaox/daemon`). Acrescentar:

```ts
  it('queues beyond max_concurrent_runs and drains in order', async () => {
    // config { max_concurrent_runs: 2 }, org max_concurrent_runs: 5, mock adapter with a script that awaits a per-run gate
    // submit 3 runs → active() { running: 2, queued: 1 }; release the first gate → third starts
  });
  it('restart keeps the pending approval and resumes by session id', async () => {
    // fake query: first call yields init(session_id 's1') then blocks in canUseTool (handler promise never resolved because we stop the manager);
    // manager.stop({ force: true }) → new RunManager over the same store → start() → state waiting_approval, node pending with sessionId 's1';
    // inbox.answer('approval:<id>', approved) → manager resumes → second query call has options.resume === 's1' → completed
  });
  it('a human node waits in the inbox and answering it resumes the run', ...);
  it('resume refuses when the worktree was removed', ...);
```

- [ ] **Step 2: Correr e ver falhar**, **Step 3: implementar** (mover código do CLI; `apps/cli/src/wiring.ts` passa a `export * from '@shibaox/daemon'` até à Task 11), **Step 4: `pnpm build && pnpm test && pnpm lint`**, **Step 5: commit**

```bash
git add packages/daemon apps/cli
git commit -m "feat(daemon): run manager with queue, concurrency, restart recovery and vault notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Servidor HTTP em socket Unix, SSE e cliente

**Files:**
- Create: `packages/daemon/src/server.ts`, `src/client.ts`, `src/daemon.ts`
- Modify: `packages/daemon/src/index.ts`, `package.json` (`exports["./client"]`)
- Test: `packages/daemon/test/server.test.ts`

**Interfaces:**
- Produces:

```ts
export interface DaemonOptions {
  home?: HomePaths; config?: DaemonConfig; env?: NodeJS.ProcessEnv; log?: (l: string) => void;
  store?: EventStore; queryFn?: QueryFn; graphify?: Graphify; extraProviders?: ProviderEntry[];
  channels?: Channel[]; now?: () => string; version?: string;
}
export class Daemon {
  constructor(opts?: DaemonOptions);
  readonly paths: HomePaths; readonly inbox: InboxService; readonly runs: RunManager;
  start(): Promise<void>;   // abre SQLite (se não injetado), remove socket órfão, escuta, chmod 0600, escreve pid, runs.start(), canais, scheduler
  stop(opts?: { force?: boolean }): Promise<void>;
}
export class DaemonClient {
  constructor(socketPath: string);
  health(): Promise<Health>;
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }>;
  listRuns(q?: { status?: string; org?: string }): Promise<RunSummaryPlus[]>;
  getRun(id: string): Promise<RunState>;
  events(id: string, opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Envelope>;
  cancel(id: string): Promise<RunState>;
  resume(id: string, o?: { budgetUsd?: number }): Promise<RunState>;
  inbox(): Promise<InboxItem[]>;
  answer(id: string, a: { approved: boolean; note?: string; via?: 'cli' | 'api' }): Promise<{ runId: string }>;
  schedules(): Promise<ScheduleRow[]>; addSchedule(s): Promise<ScheduleRow>; removeSchedule(id): Promise<void>; runSchedule(id): Promise<{ runId: string }>;
  shutdown(o?: { force?: boolean }): Promise<void>;
}
export class DaemonHttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) }
export type Envelope = { kind: 'run'; seq: number; event: StoredEvent } | { kind: 'runtime'; seq: number; event: RuntimeEnvelope };
export async function ensureDaemon(opts: { paths: HomePaths; spawn: () => void; version: string; timeoutMs?: number }): Promise<DaemonClient>;
```

Servidor: `http.createServer` a escutar em `paths.socket`; router simples por método + regex; corpo JSON (limite 1 MB); erros `{ error: { code, message } }`; `GET /runs/:id/events`: `Content-Type: text/event-stream`, envia primeiro o histórico (`store.read` desde `Last-Event-ID`/`?since`, seq = índice do evento no run) e o buffer de runtime, depois os novos por `store.subscribe` (filtrado por runId) e `runs.onRuntimeEvent`; termina quando o run fica terminal (envia `event: end`). `seq` dos envelopes de runtime = contador por run a partir de 1_000_000 para não colidir. Cliente: `fetch` não suporta socket Unix em Node; usar `http.request({ socketPath, path, method })` com um helper `requestJson`; `events()` parseia SSE linha a linha.

`Daemon.start()`: se `paths.socket` existe, tenta ligar; ligação recusada → `unlinkSync`; ligação aceite → erro "A shibaox daemon is already running". Depois `listen(paths.socket)`, `chmodSync(paths.socket, 0o600)`, `writeFileSync(paths.pid, String(process.pid))`. `stop()`: fecha servidor, `runs.stop`, canais, `unlinkSync` socket e pid, fecha SQLite.

- [ ] **Step 1: Testes a falhar** (`server.test.ts`: `Daemon` com `home` num diretório temporário, `store` em memória, canais `[]`, adaptador mock através do org do `scaffoldOrg`):

```ts
  it('health, submit, events and completion through the client', ...); // events() yields RunCreated…RunCompleted then ends
  it('second answer gets 409', ...);                     // client.answer twice → DaemonHttpError status 409
  it('replaces a stale socket file', ...);               // writeFileSync(paths.socket, '') before start(); start succeeds
  it('client disconnect does not cancel the run', ...);  // abort the events() signal mid-run; getRun later → completed
  it('refuses to start when another daemon owns the socket', ...);
  it('POST /runs with an unknown workflow is 400 and writes no event', ...);
  it('resume of a run waiting on an approval is 409 with the approve hint', ...);
```

- [ ] **Step 2–4:** correr, implementar, correr. **Step 5: commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): unix-socket HTTP API with SSE, client and daemon lifecycle

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Canais: outbox, macOS, Telegram

**Files:**
- Create: `packages/daemon/src/channels/types.ts`, `outbox.ts`, `macos.ts`, `telegram.ts`
- Modify: `packages/daemon/src/daemon.ts` (liga canais ao inbox)
- Test: `packages/daemon/test/telegram.test.ts`, `test/outbox.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Channel {
  id: 'macos' | 'telegram';
  notify(item: InboxItem): Promise<void>;
  resolved?(item: InboxItem, answer: InboxAnswer): Promise<void>;
  onAnswer?(cb: (id: InboxId, a: { approved: boolean; note?: string }) => Promise<void>): void;
  start?(): Promise<void>; stop?(): Promise<void>;
}
export class OutboxWorker {
  constructor(opts: { repo: OutboxRepo; channels: Channel[]; log; now?: () => Date; intervalMs?: number });
  enqueue(item: InboxItem): void;       // uma linha por canal
  tick(): Promise<void>;                 // envia os due; sucesso → remove; erro → retry com backoff [5s, 30s, 2m, 10m, 1h...]
  start(): void; stop(): void; clear(inboxId: string): void;
}
export function macosChannel(opts: { exec?: typeof runArgv }): Channel;   // osascript / terminal-notifier
export interface TelegramOptions { token: string; chatId: number; apiBase?: string; fetch?: typeof fetch; log; pollTimeoutSeconds?: number }
export function telegramChannel(opts: TelegramOptions): Channel;
```

Texto das mensagens (sentence case, sem emoji):
- Aprovação: `Approval needed\nRun ${runId.slice(0, 8)} · node ${nodeId} · role ${role}\n<code>${command}</code>` com `parse_mode: 'HTML'` e `command` escapado; botões `[{ text: 'Approve', callback_data: 'approve:<id>' }, { text: 'Deny', callback_data: 'deny:<id>' }]`.
- Human: `Decision needed\nRun … · node …\n${prompt}` com os mesmos botões.
- Resolvido: `editMessageText` → `${original}\n\nApproved via ${via}` / `Denied via ${via}`; o canal guarda `message_id` por `inboxId` em memória.
- Long polling: loop `getUpdates?timeout=30&offset=` (usar `pollTimeoutSeconds` para os testes); `callback_query` com `message.chat.id !== chatId` → `log('[telegram] ignored callback from chat <id>')` e `answerCallbackQuery` com "Not allowed"; válido → `cb(id, { approved })`, `answerCallbackQuery` com "Approved"/"Denied"; erro `AlreadyResolvedError` → "Already answered".
- macOS: `osascript -e 'display notification "<body>" with title "Shibaox" subtitle "<title>"'`; se `terminal-notifier` no PATH: `terminal-notifier -title Shibaox -subtitle "<title>" -message "<body>" -activate com.apple.Terminal`. Só registado quando `process.platform === 'darwin'` e `config.channels.macos.enabled`.

- [ ] **Step 1: Testes a falhar**: `telegram.test.ts` com um `http.createServer` falso que regista `sendMessage`, responde a `getUpdates` com uma fila controlada pelo teste, e `editMessageText`/`answerCallbackQuery`: (a) `notify` envia a mensagem com os dois botões; (b) callback do chat certo chama `cb('approval:a1', { approved: true })` e responde ao callback; (c) `ignores callbacks from other chats`; (d) `resolved` edita a mensagem. `outbox.test.ts` com `OutboxRepo` em SQLite temporário: canal que falha duas vezes → `attempts` 2 e `nextAt` com backoff; sucesso → linha removida; `clear` remove.

- [ ] **Step 2–4:** correr, implementar, correr. **Step 5:** `daemon.ts`: `inbox.onItem` → `outbox.enqueue`; `inbox.onResolved` → `outbox.clear(id)` + `channel.resolved?.()`; `channel.onAnswer` → `inbox.answer(id, { ...a, via: channel.id === 'telegram' ? 'telegram' : 'api' })`. **Step 6: commit**

```bash
git add packages/daemon
git commit -m "feat(daemon): notification channels with outbox retry, macOS and Telegram approvals

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Agendamentos

**Files:**
- Create: `packages/daemon/src/scheduler.ts`
- Modify: `packages/daemon/src/server.ts` (rotas `/schedules`), `src/client.ts`, `src/daemon.ts`, `package.json` (`croner`)
- Test: `packages/daemon/test/scheduler.test.ts`

**Interfaces:**
- Produces:

```ts
export class Scheduler {
  constructor(opts: { repo: SchedulesRepo; runs: RunManager; log; now?: () => Date; intervalMs?: number });
  add(s: Omit<ScheduleRow, 'id' | 'createdAt' | 'enabled'> & { enabled?: boolean }): ScheduleRow; // valida o cron com `new Cron(pattern)` → erro "invalid cron expression: <pattern>"
  list(): ScheduleRow[]; remove(id): void;
  runNow(id): Promise<{ runId: string }>;
  tick(): Promise<void>;   // para cada schedule enabled: due = Cron(cron).nextRun(lastTick) <= now; se due e (lastRunId ausente ou terminal) → submit; senão log "Skipped schedule <id>: previous run <runId> is still running"
  start(): void; stop(): void;
}
```

- [ ] **Step 1: Testes a falhar**: relógio injetado; schedule `* * * * *`; `tick()` com `now` um minuto depois → `runs.submit` chamado uma vez com os campos guardados e `lastRunId` atualizado; segundo `tick()` com o run anterior ainda `running` (RunManager falso) → não submete e regista o aviso; `add` com cron inválido lança; rotas do servidor `POST /schedules`, `GET`, `DELETE`, `POST /schedules/:id/run` pelo cliente.

- [ ] **Step 2–4:** correr, implementar, correr. **Step 5: commit**

```bash
git add packages/daemon pnpm-lock.yaml
git commit -m "feat(daemon): cron schedules that submit runs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: CLI como cliente, `--json`, `daemon`, `follow`, `inbox`, `schedule`, `doctor`, README

**Files:**
- Create: `apps/cli/src/commands/daemon.ts`, `follow.ts`, `inbox.ts`, `schedule.ts`, `cancel.ts`, `apps/cli/src/output.ts`, `apps/cli/src/client.ts`
- Modify: `apps/cli/src/index.ts`, `commands/run.ts`, `resume.ts`, `runs.ts`, `replay.ts`, `doctor.ts`, `init.ts` (importa `scaffoldOrg` de `@shibaox/daemon`)
- Delete: `apps/cli/src/wiring.ts`, `apps/cli/src/terminal-human.ts`, `apps/cli/test/wiring.test.ts` (os testes de wiring passam para `packages/daemon/test/runtime.test.ts` na Task 7 se ainda não passaram)
- Modify: `README.md`
- Test: `apps/cli/test/cli-daemon.test.ts`

**Interfaces:**
- Consumes: `DaemonClient`, `ensureDaemon`, `Daemon`, `homePaths`.
- Produces (CLI):

```ts
// apps/cli/src/client.ts
export async function connect(opts: { json?: boolean }): Promise<DaemonClient>;
// ensureDaemon com spawn = child_process.spawn(process.execPath, [process.argv[1], 'daemon', 'start'], { detached: true, stdio: ['ignore', logFd, logFd] }).unref();
// versão diferente → escrita recusada com a mensagem da spec §11

// apps/cli/src/output.ts
export interface Out { json: boolean; line(text: string): void; obj(o: unknown): void; }
export function makeOut(json: boolean): Out;    // json: uma linha JSON por obj(); line() ignorado em modo json
```

Comandos e comportamento (todos com `--json`):
- `daemon start [--detach]`: foreground cria `new Daemon({ version })` e `start()`, fica à espera de SIGINT/SIGTERM → `stop()`; `--detach` faz o spawn e imprime "Started the shibaox daemon (log: <path>)". `daemon stop [--force]`, `daemon status`.
- `run <workflow> --org --project --input [--adapter] [--workspace] [--budget] [--detach]`: `connect` → `submitRun` (org e project resolvidos para absolutos) → imprime `run <id> queued` e avisos; sem `--detach`, `follow`. `Ctrl-C` (SIGINT) durante o follow: aborta o SSE e imprime "Run <id> keeps running. Follow it with: shibaox follow <id>", `exitCode 0`.
- `follow <runId> [--since <n>]`: imprime eventos: `run` → `[<runId8>] <type> <nodeId>`; `runtime` → `text` como linhas, `tool_use` como `  ▸ <name> <input resumido>` (sem emoji: usar `>`), `tool_result` como `  < <name> (<durationMs> ms)`, `parentToolUseId` → indentação extra. Ao ver `HumanRequested`/`ToolApprovalRequested` com `stdin.isTTY`: pergunta `(y/n)` e faz `answer` (via `cli`); sem TTY: imprime "Waiting for approval: shibaox approve <id>". Termina no evento `end`; exit 0 se `completed`, 2 caso contrário.
- `runs [--status] [--org]`, `replay <runId> [--db <path>]` (com `--db` abre o SQLite offline como hoje; sem `--db` pede `getRun` ao daemon e imprime `printState`), `resume <runId> [--budget]`, `cancel <runId>`.
- `inbox`, `approve <id> [--note]`, `deny <id> [--note]`.
- `schedule add "<cron>" <workflow> --org --project [--input] [--adapter] [--budget]`, `schedule list`, `schedule rm <id>`, `schedule run <id>`.
- `doctor`: linhas novas `daemon` (health + versão), `telegram` (`daemon.yaml` tem telegram e `getMe` ok; não é required), `claude auth` (`claude auth status` exit 0 se `claude` existe; warn caso contrário).
- `init`: inalterado na superfície; `scaffoldOrg` vem de `@shibaox/daemon`.

README: nova secção "Daemon" (o que é, `~/.shibaox`, comandos, aprovações pelo inbox e Telegram, `daemon.yaml` de exemplo, agendamentos, `--json`), atualizar "Claude Code" (aprovações já não falham o run), e o quick start (`shibaox daemon start --detach` é automático).

- [ ] **Step 1: Teste a falhar** (`apps/cli/test/cli-daemon.test.ts`): arranca um `Daemon` em processo com `SHIBAOX_HOME` temporário e store em memória; corre o CLI por `execFile(process.execPath, [dist/index.js, ...])` com `env: { SHIBAOX_HOME, PATH }`:

```ts
  it('run --detach, runs --json, follow and approve complete a mock run', ...);
  // run --detach → JSON { runId }; runs --json contém o run; inbox --json mostra human:<id>:ship; approve → follow termina com completed
  it('run without --detach follows and exits 2 when the run fails', ...);
  it('inbox is empty and daemon status reports the version', ...);
  it('schedule add/list/rm round-trip', ...);
```

(Não testar o auto-arranque destacado no vitest: cobrir `ensureDaemon` com um `spawn` falso que arranca o `Daemon` em processo.)

- [ ] **Step 2–4:** correr, implementar, `pnpm build && pnpm test && pnpm lint`. **Step 5:** README. **Step 6: commit**

```bash
git add apps/cli README.md packages/daemon
git commit -m "feat(cli): daemon client commands, follow, inbox, schedules, --json and doctor checks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 7: Testes reais opt-in** (`apps/cli/test/real.test.ts`, gated por `SHIBAOX_REAL_TESTS`): um run `claude-code` cuja task instrui `git push origin main` num repo temporário com um remote bare local → o inbox mostra `approval:<id>` com `program: git`; `approve` → o push chega ao bare (`git -C bare log` tem o commit); e `apiKeySource` no stream não é `ANTHROPIC_API_KEY` para um papel de subscrição. Commit à parte:

```bash
git add apps/cli/test/real.test.ts
git commit -m "test(cli): opt-in real Claude Code approval flow through the daemon

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Self-review

**Cobertura da spec:** §1 processos/ficheiros → T6 (home/config), T8 (socket, pid, órfão), T11 (`daemon start|stop|status`, auto-arranque). §2 estado → T1 (`orgRoot`), T3 (tabelas, subscribe), T7 (uma base por utilizador via `homePaths`). §3 API → T8, T10. §4 aprovações e sessões → T1, T2, T4, T5, T6, T7 (restart). §5 ciclo de vida → T1/T2 (`queued`, `RunStarted`), T7 (fila, limites, retoma, stop). §6 agendamentos → T3, T10, T11. §7 stream → T2 (`onRuntimeEvent`, ids), T4/T5 (ids, durações, subagentes), T7 (buffer), T8 (SSE). §8 canais → T9. §9 CLI → T11. §10 alterações → T1–T5. §11 erros → T7 (worktree removido), T8 (409, 400, órfão, já a correr), T9 (backoff), T11 (versão). §12 testes → cada task; reais em T11 Step 7. Fora de âmbito respeitado (sem Ink, swarm, servidor).

**Placeholders:** nenhum "TBD"; as tasks 5, 7, 8, 9, 10 descrevem os testes por casos nomeados em vez de código completo porque reutilizam fixtures existentes (`fake server` do adapter-direct, `scaffoldOrg`, `fakeQuery`); os nomes dos casos são obrigatórios.

**Consistência de tipos:** `ApprovalHandler.request(req, { signal })` (T2) usado por T4, T5, T6; `ApprovalAnswer.deferred` com `approvalId` (T2, T4, T6); `TaskJob.approvedCommands` obrigatório em T2 e preenchido em T2 `executeNode` (o `MockAdapter` e testes que constroem `TaskJob` à mão têm de passar `approvedCommands: {}`); `RuntimeEvent.session` (T2) emitido por T4 e consumido por T2/T7; `InboxId` (T6) usado por T8/T9/T11; `RunManager.submit` (T7) usado por T8/T10; `Envelope` (T8) usado por T11.

**Review Focus:** 1 → T7 `restart keeps the pending approval and resumes by session id`; 2 → T8 `second answer gets 409`; 3 → T8 `replaces a stale socket file`; 4 → T8 `client disconnect does not cancel the run`; 5 → T9 `ignores callbacks from other chats`.
