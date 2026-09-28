# shibaox Fase 1B-1 (fornecedores, runtime direto, Jev, router, endurecimento) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correr `hello-feature` fim a fim com um modelo real através de um fornecedor direto (Ollama, LM Studio, OpenRouter ou qualquer entrada do catálogo), com decisões e checks Jev, router de `models.yaml` e judge por LLM, sobre um motor endurecido (cancelamento, custos de checks, snapshot do workflow, deteção de stall).

**Architecture:** Novo pacote `@wizardingcode/shibaox-providers` (catálogo YAML + registry sobre o Vercel AI SDK 7 + `LlmClient` + `judgeCheckRunner` + `LeadDecider`), novo pacote `@wizardingcode/shibaox-jev` (cliente TypeSafe, `fanOut`, `gateByConfidence`, `JevDecider`, `jevCheckRunner`), novo pacote `@wizardingcode/shibaox-adapter-direct` (`RuntimeAdapter` que corre o loop de agente do AI SDK com ferramentas restritas ao workspace), router `resolveModel` em `@wizardingcode/shibaox-core`, e a CLI a ligar tudo (`providers`, `models`, `run --adapter direct`). Testes usam um servidor fake OpenAI-compatible e um servidor fake Jev em processo; testes reais só quando a chave existe.

**Tech Stack:** ai@^7.0.116, @ai-sdk/openai-compatible@^3.0.57, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai, @ai-sdk/xai, @ai-sdk/azure, @ai-sdk/amazon-bedrock, @ai-sdk/google-vertex, @ai-sdk/groq, @ai-sdk/mistral, @ai-sdk/cohere, @ai-sdk/deepseek, @ai-sdk/cerebras, @ai-sdk/deepinfra, @ai-sdk/fireworks, @ai-sdk/togetherai, @ai-sdk/moonshotai, @ai-sdk/alibaba, @ai-sdk/minimax, @ai-sdk/huggingface, @ai-sdk/perplexity, @ai-sdk/zai, @openrouter/ai-sdk-provider@^3.1.0, @typesafe-ai/sdk@^0.6.0, zod 4, yaml 2, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-25-shibaox-1b-design.md` (secções 1, 2, 3, 4, 7) sobre `docs/superpowers/specs/2026-09-25-shibaox-design.md`.

## Global Constraints

- ESM, `module: NodeNext`, imports relativos com `.js`, `strict: true`, sem `any` fora de testes (casts tipados de respostas HTTP são aceitáveis).
- Eventos imutáveis; estado sempre por `replay`. O runtime nunca conhece o workflow.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` verdes (lint: 0 erros) antes de cada commit. Commits `type(scope): message` em inglês com trailer `Co-Authored-By` do modelo que escreveu.
- Nenhum teste faz chamadas de rede reais por defeito. Testes reais usam `describe.skipIf(!process.env.X)`.
- Nomes que outros pacotes consomem (não alterar): `ProviderRegistry`, `loadCatalog`, `LlmClient`, `judgeCheckRunner`, `LeadDecider`, `JevClient`, `fanOut`, `gateByConfidence`, `JevDecider`, `jevCheckRunner`, `DirectAdapter`, `resolveModel`, `ModelResolution`.
- Convenção do AI SDK 7 usada em todo o plano: `generateText({ model, system, messages, tools, stopWhen: isStepCount(n), abortSignal, output: Output.object({ schema }) })` → `{ text, output, usage: { inputTokens, outputTokens }, steps }`; `tool({ description, inputSchema, execute })`. Se uma assinatura diferir na versão instalada, o implementador adapta minimamente e regista no report.
- Ollama e LM Studio entram como `openai-compatible` (`http://localhost:11434/v1`, `http://localhost:1234/v1`) com `auth: none`.

## Review Focus

1. Uma chave em falta tem de dar um erro claro antes de qualquer chamada (`providers test` e `run`), nunca um 401 opaco a meio de um run. Teste na Task 3 e Task 8.
2. Uma tool do DirectAdapter nunca pode ler/escrever fora do workspace, mesmo com `../` ou caminhos absolutos. Teste na Task 7.
3. Um modelo que responde texto sem chamar `finish` tem de terminar o nó com esse texto como output, não pendurar até `maxSteps`. Teste na Task 7.
4. Uma resposta Jev com confiança abaixo do limiar nunca aprova sozinha um check; escala ou reprova. Teste na Task 5.
5. Um run cancelado a meio de uma tarefa tem de abortar a chamada ao modelo (signal) e ficar `cancelled`, sem eventos posteriores a alterarem o estado. Teste na Task 1.

---

### Task 1: Cancelamento por run (AbortSignal) e remoção de `cancel(jobId)`

**Files:**
- Modify: `packages/core/src/executors/types.ts`, `packages/core/src/executors/mock.ts`, `packages/core/src/run/engine.ts`
- Test: `packages/core/test/engine.test.ts` (novos casos), `packages/core/test/mock-adapter.test.ts` (ajuste)

**Interfaces:**
- Consumes: `RunEngine`, `RuntimeAdapter`, `MockAdapter` existentes.
- Produces: `RuntimeAdapter` sem `cancel`; `RunEngine.cancel(runId, reason): Promise<RunState>`; `ExecutionContext.signal` abortado no cancelamento; `MockAdapter` respeita o signal.

- [ ] **Step 1: Testes (falham)**

Em `packages/core/test/engine.test.ts` adicionar:
```ts
it('cancel() aborts the running task and leaves the run cancelled', async () => {
  const dir = scaffold(orgFiles('true'));
  let seenSignal: AbortSignal | undefined;
  const adapter = new MockAdapter(async (j, ctx) => {
    seenSignal = ctx.signal;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5_000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
    return { output: null, summary: '' };
  });
  const { engine } = engineFor(dir, { adapters: { mock: adapter } });
  const started = engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
  await new Promise((r) => setTimeout(r, 50));
  const runId = (await engine.listRuns())[0]!.runId;
  const cancelled = await engine.cancel(runId, 'user');
  expect(cancelled.status).toBe('cancelled');
  expect(seenSignal?.aborted).toBe(true);
  const final = await started;
  expect(final.status).toBe('cancelled');
  expect(final.nodes.analyse?.status).toBe('failed');
});
```
Nota: `engine.listRuns()` delega em `store.listRuns()`; adicionar o método ao engine. Em `mock-adapter.test.ts` remover a chamada a `adapter.cancel` se existir.

- [ ] **Step 2: Implementar**

`packages/core/src/executors/types.ts`: remover `cancel(jobId)` de `RuntimeAdapter`. `MockScript` passa a `(job: TaskJob, ctx: ExecutionContext) => TaskResult | Promise<TaskResult>`; `MockAdapter.run` passa `ctx` ao script e, se `ctx.signal.aborted` antes de começar, faz `yield { type: 'error', message: 'aborted' }`.

`packages/core/src/run/engine.ts`:
```ts
private readonly controllers = new Map<string, AbortController>();

private controllerFor(runId: string): AbortController {
  let c = this.controllers.get(runId);
  if (!c) { c = new AbortController(); this.controllers.set(runId, c); }
  return c;
}

async cancel(runId: string, reason: string): Promise<RunState> {
  const state = await this.state(runId);
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') return state;
  this.controllerFor(runId).abort(new Error(reason));
  await this.emit({ type: 'RunCancelled', runId, at: this.now(), reason });
  return this.state(runId);
}

async listRuns() { return this.deps.store.listRuns(); }
```
Em `executeNode`, o `ExecutionContext` passa a `{ signal: this.controllerFor(runId).signal, log: this.log }`; `drive` verifica `signal.aborted` no início de cada iteração e devolve o estado sem executar mais nós; no fim de um run terminal, `this.controllers.delete(runId)`. Como o estado terminal é fixo (1A), o `NodeFailed` que chega depois do `RunCancelled` não altera o status.

- [ ] **Step 3: Correr, commit**

Run: `pnpm --filter @wizardingcode/shibaox-core test && pnpm build && pnpm typecheck && pnpm lint`
```bash
git commit -am "feat(core): per-run AbortSignal and RunEngine.cancel; drop RuntimeAdapter.cancel"
```

---

### Task 2: Custos de checks, snapshot do workflow, deteção de stall, `resume --budget` em `waiting_human`

**Files:**
- Modify: `packages/schemas/src/events.ts` (`RunCreated.workflowSnapshot?: Workflow`, `CheckResult.cost?`), `packages/core/src/gates/engine.ts`, `packages/core/src/run/engine.ts`, `packages/core/src/run/scheduler.ts` (export helper), `apps/cli/src/commands/resume.ts`
- Test: `packages/core/test/gate-engine.test.ts`, `packages/core/test/engine.test.ts`, `packages/schemas/test/...`

**Interfaces:**
- Produces: `GateReport.cost` = soma dos `CheckResult.cost`; `RunCreated.workflowSnapshot` (o workflow resolvido com gates injetados); `RunState.workflowSnapshot?`; `RunEngine` usa o snapshot quando existe; `isStalled(state, workflow): { stalled: boolean; reason?: string }` exportado do scheduler; `resume(runId, { budgetUsd })` em `waiting_human` emite `RunResumed` antes de perguntar.

- [ ] **Step 1: Testes (falham)**

`gate-engine.test.ts`: um runner `mock` que devolve `cost: { usd: 0.02, inputTokens: 1, outputTokens: 1 }` → `report.cost.usd` é `0.02` com dois checks a `0.01` cada.

`engine.test.ts`:
```ts
it('stores the resolved workflow in RunCreated and resumes from it even if the org changed', async () => {
  const dir = scaffold(orgFiles('true'));
  const { engine, store } = engineFor(dir, { human: new DeferHuman() });
  const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
  const created = (await store.read(waiting.runId))[0];
  expect(created?.type === 'RunCreated' && created.workflowSnapshot?.nodes.qa).toBeTruthy();
  writeFileSync(join(dir, 'workflows/hello.yaml'), 'workflow: hello\nstart: only\nnodes:\n  only: { type: human, action: x }\n');
  const { engine: engine2 } = engineFor(dir, { store, human: new AutoApproveHuman() }); // same store, new org
  const done = await engine2.respond(waiting.runId, { approved: true });
  expect(done.status).toBe('completed');
  expect(done.nodes.ship?.status).toBe('completed'); // still the old workflow
});

it('cancels with a stall reason instead of completing when the scheduler reports a stall', async () => {
  const dir = scaffold(orgFiles('true'));
  const { engine, store } = engineFor(dir, {
    scheduler: { readyNodes: () => [], isStalled: () => ({ stalled: true, reason: 'node "x" is pending but no predecessor finished after it started' }) },
  });
  const s = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd() });
  expect(s.status).toBe('cancelled');
  expect(s.error).toContain('stalled: node "x"');
  expect((await store.read(s.runId)).map((e) => e.type)).not.toContain('RunCompleted');
});

it('resume with a budget while waiting_human applies the new budget', async () => {
  const dir = scaffold(orgFiles('true'));
  const { engine } = engineFor(dir, { human: new DeferHuman() });
  const waiting = await engine.start({ workflow: 'hello', input: {}, workspace: process.cwd(), budgetUsd: 1 });
  const { engine: engine2 } = engineFor(dir, { store: (engine as unknown as { deps: { store: MemoryEventStore } }).deps.store, human: new AutoApproveHuman() });
  const done = await engine2.resume(waiting.runId, { budgetUsd: 9 });
  expect(done.status).toBe('completed');
  expect(done.budgetUsd).toBe(9);
});
```
Nota: `engineFor` deve aceitar `store` nos overrides para os dois últimos testes partilharem o mesmo `MemoryEventStore` (alterar o helper para `const store = overrides.store ?? new MemoryEventStore()`), e o acesso via `deps` no terceiro teste substitui-se por reutilizar a variável `store` devolvida por `engineFor`.

`scheduler.test.ts`:
```ts
it('isStalled reports a pending node with no live path when nothing is ready', () => {
  const wf = WorkflowSchema.parse({ workflow: 'w', start: 'a', nodes: { a: { type: 'task', role: 'r', next: 'b' }, b: { type: 'task', role: 'r' } } });
  const s = replay([created, started('a'), done('a'), started('b')]);
  const interrupted = { ...s, nodes: { ...s.nodes, b: { ...s.nodes.b!, status: 'pending' as const, startedIdx: 5 } } };
  expect(readyNodes(interrupted, wf)).toEqual([]);
  expect(isStalled(interrupted, wf)).toEqual({ stalled: true, reason: 'node "b" is pending but no predecessor finished after it started' });
  expect(isStalled(replay([created, started('a'), done('a'), started('b'), done('b')]), wf)).toEqual({ stalled: false });
});
```

- [ ] **Step 2: Implementar**

- `events.ts`: `RunCreated` ganha `workflowSnapshot: WorkflowSchema.optional()`; `CheckResultSchema` ganha `cost: CostSchema.optional()`.
- `state.ts`/`reducer.ts`: `RunState.workflowSnapshot?: Workflow` preenchido em `RunCreated`.
- `gates/engine.ts`: `runGate` soma `cost` dos checks (só os que têm) em `report.cost` (omitido se nenhum).
- `scheduler.ts`: `export function isStalled(state, workflow)`: se `readyNodes` vazio e status `running`: para cada nó com status `pending` que tenha `startedIdx` definido (foi interrompido/reposto) ou `gate_failed`, verificar se existe predecessor com transição para ele e `finishedIdx > startedIdx`; se não existir → `{ stalled: true, reason }`. Caso contrário `{ stalled: false }`.
- `engine.ts`: `resolveWorkflow(state)` usa `state.workflowSnapshot ?? org lookup`; `start` grava o snapshot resolvido; em `drive`, quando `ready.length === 0`: `const st = isStalled(...)`; se `st.stalled` → `RunCancelled { reason: 'stalled: ' + st.reason }`, senão `RunCompleted`. `EngineDeps.scheduler?`. `resume` em `waiting_human` com `opts.budgetUsd` → emite `RunResumed { budgetUsd }` primeiro (status continua `waiting_human` porque o reducer só muda status em `RunResumed` se estava `paused_budget`: ajustar o reducer para `RunResumed` atualizar `budgetUsd` sempre e só mudar status quando `paused_budget`).
- `apps/cli/src/commands/resume.ts`: passar `budgetUsd` também em `waiting_human` (já passa; confirmar).

- [ ] **Step 3: Correr, commit**

```bash
git commit -am "feat(core): check costs in gate reports, workflow snapshot in RunCreated, stall detection, budget on resume"
```

---

### Task 3: `@wizardingcode/shibaox-providers` — catálogo e registry

**Files:**
- Create: `packages/providers/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/catalog-schema.ts`, `src/catalog.ts`, `src/registry.ts`, `src/factories.ts`, `catalog.yaml`
- Test: `packages/providers/test/catalog.test.ts`, `packages/providers/test/registry.test.ts`

**Interfaces:**
- Produces:
```ts
type ProviderKind = 'openai-compatible' | 'openai' | 'anthropic' | 'google' | 'xai' | 'azure' | 'bedrock' | 'vertex' | 'vertex-anthropic' | 'groq' | 'mistral' | 'cohere' | 'deepseek' | 'cerebras' | 'deepinfra' | 'fireworks' | 'togetherai' | 'moonshotai' | 'alibaba' | 'minimax' | 'huggingface' | 'perplexity' | 'zai' | 'openrouter';
type ProviderAuth = { type: 'api_key'; env: string } | { type: 'none' } | { type: 'aws' } | { type: 'gcp' } | { type: 'azure' };
interface ProviderEntry { id; name; kind?: ProviderKind; via_runtime?: string; base_url?: string; base_url_env?: string; auth?: ProviderAuth; models: string[]; pricing: Record<string, { input_per_m: number; output_per_m: number }>; verify: boolean; notes?: string }
loadCatalog(path?: string): ProviderEntry[]          // default: catalog.yaml do pacote
class ProviderRegistry { constructor(entries: ProviderEntry[], env?: NodeJS.ProcessEnv); list(); get(id); isConfigured(id): { ok: boolean; missing: string[] }; model(ref: string): LanguageModel; parseRef(ref): { provider: string; model: string }; estimateCost(ref, usage: { inputTokens: number; outputTokens: number }): number | undefined; resolveBaseUrl(entry): string | undefined }
```
`ref` tem a forma `<provider>/<model>` (o primeiro `/` separa; o resto é o id do modelo, que pode conter `/` como em `openrouter/anthropic/claude-sonnet-4.5`).

- [ ] **Step 1: Pacote**

`packages/providers/package.json`:
```json
{
  "name": "@wizardingcode/shibaox-providers",
  "version": "0.0.1",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist", "catalog.yaml"],
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": {
    "@ai-sdk/alibaba": "latest", "@ai-sdk/amazon-bedrock": "latest", "@ai-sdk/anthropic": "latest", "@ai-sdk/azure": "latest",
    "@ai-sdk/cerebras": "latest", "@ai-sdk/cohere": "latest", "@ai-sdk/deepinfra": "latest", "@ai-sdk/deepseek": "latest",
    "@ai-sdk/fireworks": "latest", "@ai-sdk/google": "latest", "@ai-sdk/google-vertex": "latest", "@ai-sdk/groq": "latest",
    "@ai-sdk/huggingface": "latest", "@ai-sdk/minimax": "latest", "@ai-sdk/mistral": "latest", "@ai-sdk/moonshotai": "latest",
    "@ai-sdk/openai": "latest", "@ai-sdk/openai-compatible": "^3.0.57", "@ai-sdk/perplexity": "latest", "@ai-sdk/togetherai": "latest",
    "@ai-sdk/xai": "latest", "@ai-sdk/zai": "latest", "@openrouter/ai-sdk-provider": "^3.1.0",
    "@wizardingcode/shibaox-core": "workspace:*", "@wizardingcode/shibaox-schemas": "workspace:*",
    "ai": "^7.0.116", "yaml": "^2.9.1", "zod": "^4.6.5"
  },
  "devDependencies": { "@types/node": "^26.6.2" }
}
```
Após `pnpm install`, substituir cada `"latest"` pela versão resolvida (`pnpm list --depth 0 --filter @wizardingcode/shibaox-providers`) com `^`, para o lockfile ficar determinístico. `vitest.config.ts` com aliases para `../core/src/index.ts` e `../schemas/src/index.ts`.

- [ ] **Step 2: Testes (falham)**

`packages/providers/test/catalog.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/index.js';

describe('catalog.yaml', () => {
  const entries = loadCatalog();
  it('has every provider from the product list, with unique ids', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['anthropic', 'anthropic-subscription', 'openai', 'openai-codex-subscription', 'google', 'gemini-cli-subscription', 'xai', 'azure', 'bedrock', 'bedrock-mantle', 'vertex', 'vertex-anthropic', 'groq', 'mistral', 'cohere', 'deepseek', 'cerebras', 'deepinfra', 'fireworks', 'togetherai', 'moonshotai', 'kimi-coding', 'alibaba', 'qwen-dashscope', 'qwen-portal-subscription', 'minimax', 'huggingface', 'perplexity', 'zai', 'zai-coding', 'openrouter', 'ollama', 'ollama-cloud', 'lmstudio', 'nvidia', 'chutes', 'novita', 'kilocode', 'litellm', 'vercel-gateway', 'cloudflare-gateway', 'clawrouter', 'microsoft-foundry', 'stepfun', 'xiaomi', 'volcengine', 'tencent-cloud', 'qianfan', 'byteplus', 'venice', 'arcee', 'synthetic', 'vydra', 'gmi-cloud', 'opencode', 'opencode-go', 'github-copilot-subscription', 'claude-max-proxy']) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });
  it('every direct entry has a kind and auth; every subscription entry has via_runtime', () => {
    for (const e of entries) {
      if (e.via_runtime) expect(e.kind).toBeUndefined();
      else { expect(e.kind, e.id).toBeDefined(); expect(e.auth, e.id).toBeDefined(); }
    }
  });
  it('openai-compatible entries have a base_url or base_url_env', () => {
    for (const e of entries.filter((e) => e.kind === 'openai-compatible')) expect(e.base_url ?? e.base_url_env, e.id).toBeTruthy();
  });
  it('rejects an invalid entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'));
    writeFileSync(join(dir, 'c.yaml'), '- id: x\n  name: X\n  kind: nope\n');
    expect(() => loadCatalog(join(dir, 'c.yaml'))).toThrow(/nope|kind/);
  });
});
```
(imports de `node:fs`, `node:os`, `node:path` no topo.)

`packages/providers/test/registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, loadCatalog } from '../src/index.js';

describe('ProviderRegistry', () => {
  const reg = (env: Record<string, string> = {}) => new ProviderRegistry(loadCatalog(), env);
  it('parses refs where the model id may contain slashes', () => {
    expect(reg().parseRef('openrouter/anthropic/claude-sonnet-4.5')).toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(() => reg().parseRef('nomodel')).toThrow(/<provider>\/<model>/);
  });
  it('reports missing env vars for api_key providers and ok for local ones', () => {
    expect(reg().isConfigured('openrouter')).toEqual({ ok: false, missing: ['OPENROUTER_API_KEY'] });
    expect(reg({ OPENROUTER_API_KEY: 'k' }).isConfigured('openrouter')).toEqual({ ok: true, missing: [] });
    expect(reg().isConfigured('ollama')).toEqual({ ok: true, missing: [] });
    expect(reg().isConfigured('bedrock').missing).toContain('AWS_REGION');
    expect(reg().isConfigured('cloudflare-gateway').missing).toContain('CLOUDFLARE_GATEWAY_URL');
  });
  it('refuses to build a model for a via_runtime provider', () => {
    expect(() => reg().model('anthropic-subscription/claude-sonnet-4-5')).toThrow(/via_runtime/);
  });
  it('builds an AI SDK model for an openai-compatible provider and a native one', () => {
    const m1 = reg().model('ollama/llama3.2');
    expect(m1).toBeDefined();
    const m2 = reg({ ANTHROPIC_API_KEY: 'k' }).model('anthropic/claude-sonnet-4-5');
    expect(m2).toBeDefined();
  });
  it('throws a clear error when the provider is not configured', () => {
    expect(() => reg().model('anthropic/claude-sonnet-4-5')).toThrow(/ANTHROPIC_API_KEY/);
  });
  it('estimates cost from pricing when present', () => {
    const r = reg({ OPENROUTER_API_KEY: 'k' });
    const usd = r.estimateCost('openrouter/anthropic/claude-sonnet-4.5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(usd).toBeCloseTo(18);
    expect(r.estimateCost('ollama/llama3.2', { inputTokens: 10, outputTokens: 10 })).toBeUndefined();
  });
});
```

- [ ] **Step 3: Implementar**

`packages/providers/src/catalog-schema.ts`:
```ts
import { z } from 'zod';

export const ProviderKindSchema = z.enum(['openai-compatible', 'openai', 'anthropic', 'google', 'xai', 'azure', 'bedrock', 'vertex', 'vertex-anthropic', 'groq', 'mistral', 'cohere', 'deepseek', 'cerebras', 'deepinfra', 'fireworks', 'togetherai', 'moonshotai', 'alibaba', 'minimax', 'huggingface', 'perplexity', 'zai', 'openrouter']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('api_key'), env: z.string().min(1) }),
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('aws') }),
  z.object({ type: z.literal('gcp') }),
  z.object({ type: z.literal('azure') }),
]);
export type ProviderAuth = z.infer<typeof ProviderAuthSchema>;

export const ProviderEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    kind: ProviderKindSchema.optional(),
    via_runtime: z.string().optional(),
    base_url: z.string().url().optional(),
    base_url_env: z.string().optional(),
    auth: ProviderAuthSchema.optional(),
    models: z.array(z.string()).default([]),
    pricing: z.record(z.string(), z.object({ input_per_m: z.number().min(0), output_per_m: z.number().min(0) })).default({}),
    verify: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.via_runtime) {
      if (e.kind) ctx.addIssue({ code: 'custom', message: `${e.id}: via_runtime entries must not set kind` });
      return;
    }
    if (!e.kind) ctx.addIssue({ code: 'custom', message: `${e.id}: kind is required for direct providers` });
    if (!e.auth) ctx.addIssue({ code: 'custom', message: `${e.id}: auth is required for direct providers` });
    if (e.kind === 'openai-compatible' && !e.base_url && !e.base_url_env) ctx.addIssue({ code: 'custom', message: `${e.id}: openai-compatible needs base_url or base_url_env` });
  });
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>;
export const CatalogSchema = z.array(ProviderEntrySchema);
```

`packages/providers/src/catalog.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CatalogSchema, type ProviderEntry } from './catalog-schema.js';

export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../catalog.yaml', import.meta.url));

export function loadCatalog(path: string = DEFAULT_CATALOG_PATH): ProviderEntry[] {
  const raw = parse(readFileSync(path, 'utf8'));
  const r = CatalogSchema.safeParse(raw);
  if (!r.success) throw new Error(`invalid provider catalog ${path}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const ids = new Set<string>();
  for (const e of r.data) {
    if (ids.has(e.id)) throw new Error(`invalid provider catalog ${path}: duplicate id "${e.id}"`);
    ids.add(e.id);
  }
  return r.data;
}
```
Nota: `dist/catalog.js` resolve `../catalog.yaml` para a raiz do pacote, tal como `src/catalog.ts`; por isso `catalog.yaml` vive na raiz de `packages/providers`.

`packages/providers/src/factories.ts` (uma função por `kind`, todas com a mesma assinatura):
```ts
import { createAlibaba } from '@ai-sdk/alibaba';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCerebras } from '@ai-sdk/cerebras';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createFireworks } from '@ai-sdk/fireworks';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createHuggingFace } from '@ai-sdk/huggingface';
import { createMiniMax } from '@ai-sdk/minimax';
import { createMistral } from '@ai-sdk/mistral';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createPerplexity } from '@ai-sdk/perplexity';
import { createTogetherAI } from '@ai-sdk/togetherai';
import { createXai } from '@ai-sdk/xai';
import { createZai } from '@ai-sdk/zai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { ProviderEntry, ProviderKind } from './catalog-schema.js';

export interface FactoryInput { entry: ProviderEntry; model: string; apiKey?: string; baseURL?: string; env: NodeJS.ProcessEnv }
export type Factory = (i: FactoryInput) => LanguageModel;

const simple = (create: (o: { apiKey?: string; baseURL?: string }) => (id: string) => LanguageModel): Factory => (i) => create({ apiKey: i.apiKey, baseURL: i.baseURL })(i.model);

export const FACTORIES: Record<ProviderKind, Factory> = {
  'openai-compatible': (i) => createOpenAICompatible({ name: i.entry.id, baseURL: i.baseURL ?? '', apiKey: i.apiKey, supportsStructuredOutputs: true })(i.model),
  openai: (i) => createOpenAI({ apiKey: i.apiKey, baseURL: i.baseURL }).chat(i.model),
  anthropic: simple(createAnthropic),
  google: simple(createGoogleGenerativeAI),
  xai: simple(createXai),
  azure: (i) => createAzure({ resourceName: i.env.AZURE_RESOURCE_NAME, apiKey: i.apiKey })(i.model),
  bedrock: (i) => createAmazonBedrock({ region: i.env.AWS_REGION, accessKeyId: i.env.AWS_ACCESS_KEY_ID, secretAccessKey: i.env.AWS_SECRET_ACCESS_KEY, sessionToken: i.env.AWS_SESSION_TOKEN, apiKey: i.env.AWS_BEARER_TOKEN_BEDROCK })(i.model),
  vertex: (i) => createVertex({ project: i.env.GOOGLE_VERTEX_PROJECT, location: i.env.GOOGLE_VERTEX_LOCATION })(i.model),
  'vertex-anthropic': (i) => createVertexAnthropic({ project: i.env.GOOGLE_VERTEX_PROJECT, location: i.env.GOOGLE_VERTEX_LOCATION })(i.model),
  groq: simple(createGroq),
  mistral: simple(createMistral),
  cohere: simple(createCohere),
  deepseek: simple(createDeepSeek),
  cerebras: simple(createCerebras),
  deepinfra: simple(createDeepInfra),
  fireworks: simple(createFireworks),
  togetherai: simple(createTogetherAI),
  moonshotai: simple(createMoonshotAI),
  alibaba: simple(createAlibaba),
  minimax: simple(createMiniMax),
  huggingface: simple(createHuggingFace),
  perplexity: simple(createPerplexity),
  zai: simple(createZai),
  openrouter: (i) => createOpenRouter({ apiKey: i.apiKey, baseURL: i.baseURL }).chat(i.model),
};
```
Se um `create*` não aceitar `baseURL` ou tiver outro nome de opção, o implementador adapta essa linha e regista no report; o `Record<ProviderKind, Factory>` garante que nenhum `kind` fica sem fábrica.

`packages/providers/src/registry.ts`:
```ts
import type { LanguageModel } from 'ai';
import type { ProviderEntry } from './catalog-schema.js';
import { FACTORIES } from './factories.js';

const REQUIRED_ENV: Record<'aws' | 'gcp' | 'azure', string[]> = {
  aws: ['AWS_REGION'],
  gcp: ['GOOGLE_VERTEX_PROJECT', 'GOOGLE_VERTEX_LOCATION'],
  azure: ['AZURE_RESOURCE_NAME', 'AZURE_API_KEY'],
};

export class ProviderRegistry {
  private readonly byId = new Map<string, ProviderEntry>();
  constructor(entries: ProviderEntry[], private readonly env: NodeJS.ProcessEnv = process.env) {
    for (const e of entries) this.byId.set(e.id, e);
  }
  list(): ProviderEntry[] { return [...this.byId.values()]; }
  get(id: string): ProviderEntry {
    const e = this.byId.get(id);
    if (!e) throw new Error(`unknown provider "${id}" (see: shibaox providers list)`);
    return e;
  }
  parseRef(ref: string): { provider: string; model: string } {
    const i = ref.indexOf('/');
    if (i <= 0 || i === ref.length - 1) throw new Error(`model ref "${ref}" must look like <provider>/<model>`);
    return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
  }
  resolveBaseUrl(e: ProviderEntry): string | undefined {
    if (e.base_url_env) return this.env[e.base_url_env] ?? undefined;
    return e.base_url;
  }
  isConfigured(id: string): { ok: boolean; missing: string[] } {
    const e = this.get(id);
    const missing: string[] = [];
    if (e.via_runtime) return { ok: true, missing };
    if (e.auth?.type === 'api_key' && !this.env[e.auth.env]) missing.push(e.auth.env);
    if (e.auth && e.auth.type !== 'api_key' && e.auth.type !== 'none') for (const v of REQUIRED_ENV[e.auth.type]) if (!this.env[v]) missing.push(v);
    if (e.auth?.type === 'aws' && !this.env.AWS_BEARER_TOKEN_BEDROCK && !(this.env.AWS_ACCESS_KEY_ID && this.env.AWS_SECRET_ACCESS_KEY)) missing.push('AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_BEARER_TOKEN_BEDROCK');
    if (e.base_url_env && !this.env[e.base_url_env]) missing.push(e.base_url_env);
    return { ok: missing.length === 0, missing };
  }
  model(ref: string): LanguageModel {
    const { provider, model } = this.parseRef(ref);
    const e = this.get(provider);
    if (e.via_runtime) throw new Error(`provider "${e.id}" is a via_runtime provider (${e.via_runtime}); it cannot be used as a direct model`);
    const cfg = this.isConfigured(e.id);
    if (!cfg.ok) throw new Error(`provider "${e.id}" is not configured: set ${cfg.missing.join(', ')}`);
    const apiKey = e.auth?.type === 'api_key' ? this.env[e.auth.env] : e.auth?.type === 'none' ? 'local' : undefined;
    return FACTORIES[e.kind as NonNullable<ProviderEntry['kind']>]({ entry: e, model, apiKey, baseURL: this.resolveBaseUrl(e), env: this.env });
  }
  estimateCost(ref: string, usage: { inputTokens: number; outputTokens: number }): number | undefined {
    const { provider, model } = this.parseRef(ref);
    const p = this.get(provider).pricing[model];
    if (!p) return undefined;
    return (usage.inputTokens / 1_000_000) * p.input_per_m + (usage.outputTokens / 1_000_000) * p.output_per_m;
  }
}
```
Nota sobre `auth: none` e `apiKey: 'local'`: alguns servidores locais rejeitam um header `Authorization` vazio; um valor dummy é a prática habitual para Ollama/LM Studio.

`packages/providers/src/index.ts`: `export * from './catalog-schema.js'; export * from './catalog.js'; export * from './registry.js';`

`packages/providers/catalog.yaml` (escrever completo; as entradas marcadas `verify: true` têm URLs que não foram confirmadas e `shibaox providers test` avisa):
```yaml
# Direct APIs
- { id: anthropic, name: Anthropic (API key), kind: anthropic, auth: { type: api_key, env: ANTHROPIC_API_KEY }, models: [claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5], pricing: { claude-haiku-4-5: { input_per_m: 1, output_per_m: 5 } } }
- { id: anthropic-subscription, name: Anthropic (Claude subscription via Claude Code), via_runtime: claude-code, models: [claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5], notes: Uses the login already present in the Claude Code CLI }
- { id: openai, name: OpenAI (API key), kind: openai, auth: { type: api_key, env: OPENAI_API_KEY }, models: [gpt-5, gpt-5-mini] }
- { id: openai-codex-subscription, name: OpenAI (ChatGPT/Codex sign-in via Codex CLI), via_runtime: codex, models: [gpt-5-codex] }
- { id: google, name: Google Gemini (API key), kind: google, auth: { type: api_key, env: GOOGLE_GENERATIVE_AI_API_KEY }, models: [gemini-2.5-pro, gemini-2.5-flash] }
- { id: gemini-cli-subscription, name: Google Gemini (OAuth via Gemini CLI), via_runtime: gemini-cli, models: [gemini-2.5-pro] }
- { id: xai, name: xAI Grok, kind: xai, auth: { type: api_key, env: XAI_API_KEY }, models: [grok-4] }
- { id: mistral, name: Mistral, kind: mistral, auth: { type: api_key, env: MISTRAL_API_KEY }, models: [mistral-large-latest, codestral-latest] }
- { id: deepseek, name: DeepSeek, kind: deepseek, auth: { type: api_key, env: DEEPSEEK_API_KEY }, models: [deepseek-chat, deepseek-reasoner] }
- { id: cohere, name: Cohere, kind: cohere, auth: { type: api_key, env: COHERE_API_KEY }, models: [command-a-03-2025] }
- { id: moonshotai, name: Moonshot / Kimi (API key), kind: moonshotai, auth: { type: api_key, env: MOONSHOT_API_KEY }, models: [kimi-k2-0905-preview] }
- { id: kimi-coding, name: Kimi for Coding (Coding Plan), kind: openai-compatible, base_url: https://api.kimi.com/coding/v1, auth: { type: api_key, env: KIMI_CODING_API_KEY }, verify: true }
- { id: alibaba, name: Alibaba Model Studio (official provider), kind: alibaba, auth: { type: api_key, env: ALIBABA_API_KEY }, models: [qwen3-max, qwen3-coder-plus] }
- { id: qwen-dashscope, name: Qwen Cloud (DashScope, OpenAI-compatible), kind: openai-compatible, base_url: https://dashscope-intl.aliyuncs.com/compatible-mode/v1, auth: { type: api_key, env: DASHSCOPE_API_KEY }, models: [qwen3-coder-plus] }
- { id: qwen-portal-subscription, name: Qwen Portal (OAuth via Qwen Code CLI), via_runtime: qwen-code }
- { id: minimax, name: MiniMax, kind: minimax, auth: { type: api_key, env: MINIMAX_API_KEY }, models: [MiniMax-M2] }
- { id: zai, name: Z.AI GLM (API key), kind: zai, auth: { type: api_key, env: ZAI_API_KEY }, models: [glm-4.6] }
- { id: zai-coding, name: Z.AI GLM Coding Plan, kind: openai-compatible, base_url: https://api.z.ai/api/coding/paas/v4, auth: { type: api_key, env: ZAI_API_KEY }, models: [glm-4.6], verify: true }
- { id: stepfun, name: StepFun, kind: openai-compatible, base_url: https://api.stepfun.com/v1, auth: { type: api_key, env: STEPFUN_API_KEY }, verify: true }
- { id: xiaomi, name: Xiaomi MiMo, kind: openai-compatible, base_url: https://api.xiaomimimo.com/v1, auth: { type: api_key, env: XIAOMI_API_KEY }, verify: true }
- { id: volcengine, name: Volcengine Ark, kind: openai-compatible, base_url: https://ark.cn-beijing.volces.com/api/v3, auth: { type: api_key, env: ARK_API_KEY } }
- { id: tencent-cloud, name: Tencent Hunyuan, kind: openai-compatible, base_url: https://api.hunyuan.cloud.tencent.com/v1, auth: { type: api_key, env: HUNYUAN_API_KEY } }
- { id: qianfan, name: Baidu Qianfan, kind: openai-compatible, base_url: https://qianfan.baidubce.com/v2, auth: { type: api_key, env: QIANFAN_API_KEY } }
- { id: byteplus, name: BytePlus Ark, kind: openai-compatible, base_url: https://ark.ap-southeast.bytepluses.com/api/v3, auth: { type: api_key, env: BYTEPLUS_API_KEY } }
- { id: venice, name: Venice, kind: openai-compatible, base_url: https://api.venice.ai/api/v1, auth: { type: api_key, env: VENICE_API_KEY } }
- { id: arcee, name: Arcee AI, kind: openai-compatible, base_url: https://conductor.arcee.ai/v1, auth: { type: api_key, env: ARCEE_API_KEY }, verify: true }
- { id: synthetic, name: Synthetic, kind: openai-compatible, base_url: https://api.synthetic.new/v1, auth: { type: api_key, env: SYNTHETIC_API_KEY }, verify: true }
- { id: vydra, name: Vydra, kind: openai-compatible, base_url_env: VYDRA_BASE_URL, auth: { type: api_key, env: VYDRA_API_KEY }, verify: true }
- { id: gmi-cloud, name: GMI Cloud, kind: openai-compatible, base_url: https://api.gmi-serving.com/v1, auth: { type: api_key, env: GMI_API_KEY }, verify: true }
- { id: opencode, name: OpenCode Zen, kind: openai-compatible, base_url: https://opencode.ai/zen/v1, auth: { type: api_key, env: OPENCODE_API_KEY }, verify: true }
- { id: opencode-go, name: OpenCode Go, kind: openai-compatible, base_url: https://opencode.ai/zen/go/v1, auth: { type: api_key, env: OPENCODE_API_KEY }, verify: true }
- { id: github-copilot-subscription, name: GitHub Copilot (via Copilot CLI), via_runtime: copilot-cli }
- { id: claude-max-proxy, name: Claude Max API proxy (local OpenAI-compatible proxy), kind: openai-compatible, base_url_env: CLAUDE_MAX_PROXY_URL, auth: { type: none }, verify: true }
# Gateways and enterprise clouds
- { id: bedrock, name: Amazon Bedrock, kind: bedrock, auth: { type: aws }, models: [anthropic.claude-sonnet-4-5, amazon.nova-pro-v1:0] }
- { id: bedrock-mantle, name: Bedrock Mantle (OpenAI-compatible), kind: openai-compatible, base_url_env: BEDROCK_MANTLE_BASE_URL, auth: { type: api_key, env: AWS_BEARER_TOKEN_BEDROCK }, verify: true }
- { id: vertex, name: Google Vertex AI, kind: vertex, auth: { type: gcp }, models: [gemini-2.5-pro] }
- { id: vertex-anthropic, name: Anthropic on Vertex, kind: vertex-anthropic, auth: { type: gcp }, models: [claude-sonnet-4-5@20250929] }
- { id: azure, name: Azure OpenAI, kind: azure, auth: { type: azure }, models: [gpt-5] }
- { id: microsoft-foundry, name: Microsoft Foundry (OpenAI-compatible), kind: openai-compatible, base_url_env: AZURE_FOUNDRY_BASE_URL, auth: { type: api_key, env: AZURE_FOUNDRY_API_KEY }, verify: true }
- { id: cloudflare-gateway, name: Cloudflare AI Gateway (OpenAI-compatible), kind: openai-compatible, base_url_env: CLOUDFLARE_GATEWAY_URL, auth: { type: api_key, env: CLOUDFLARE_GATEWAY_API_KEY }, notes: "URL like https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat" }
- { id: vercel-gateway, name: Vercel AI Gateway, kind: openai-compatible, base_url: https://ai-gateway.vercel.sh/v1, auth: { type: api_key, env: AI_GATEWAY_API_KEY } }
- { id: openrouter, name: OpenRouter, kind: openrouter, auth: { type: api_key, env: OPENROUTER_API_KEY }, models: [anthropic/claude-sonnet-4.5, openai/gpt-5, meta-llama/llama-3.3-70b-instruct, qwen/qwen3-coder], pricing: { anthropic/claude-sonnet-4.5: { input_per_m: 3, output_per_m: 15 } } }
- { id: clawrouter, name: ClawRouter, kind: openai-compatible, base_url_env: CLAWROUTER_BASE_URL, auth: { type: api_key, env: CLAWROUTER_API_KEY }, verify: true }
- { id: litellm, name: LiteLLM proxy, kind: openai-compatible, base_url: http://localhost:4000/v1, auth: { type: api_key, env: LITELLM_API_KEY } }
- { id: kilocode, name: Kilocode gateway, kind: openai-compatible, base_url_env: KILOCODE_BASE_URL, auth: { type: api_key, env: KILOCODE_API_KEY }, verify: true }
# Hosted inference
- { id: groq, name: Groq, kind: groq, auth: { type: api_key, env: GROQ_API_KEY }, models: [llama-3.3-70b-versatile, openai/gpt-oss-120b] }
- { id: cerebras, name: Cerebras, kind: cerebras, auth: { type: api_key, env: CEREBRAS_API_KEY }, models: [llama-3.3-70b] }
- { id: togetherai, name: Together AI, kind: togetherai, auth: { type: api_key, env: TOGETHER_AI_API_KEY }, models: [meta-llama/Llama-3.3-70B-Instruct-Turbo] }
- { id: fireworks, name: Fireworks, kind: fireworks, auth: { type: api_key, env: FIREWORKS_API_KEY }, models: [accounts/fireworks/models/llama-v3p3-70b-instruct] }
- { id: nvidia, name: NVIDIA NIM, kind: openai-compatible, base_url: https://integrate.api.nvidia.com/v1, auth: { type: api_key, env: NVIDIA_API_KEY }, models: [meta/llama-3.3-70b-instruct] }
- { id: huggingface, name: Hugging Face Inference, kind: huggingface, auth: { type: api_key, env: HUGGINGFACE_API_KEY } }
- { id: deepinfra, name: DeepInfra, kind: deepinfra, auth: { type: api_key, env: DEEPINFRA_API_KEY } }
- { id: chutes, name: Chutes, kind: openai-compatible, base_url: https://llm.chutes.ai/v1, auth: { type: api_key, env: CHUTES_API_KEY }, verify: true }
- { id: novita, name: NovitaAI, kind: openai-compatible, base_url: https://api.novita.ai/v3/openai, auth: { type: api_key, env: NOVITA_API_KEY } }
- { id: perplexity, name: Perplexity, kind: perplexity, auth: { type: api_key, env: PERPLEXITY_API_KEY }, models: [sonar-pro] }
- { id: ollama-cloud, name: Ollama Cloud, kind: openai-compatible, base_url: https://ollama.com/v1, auth: { type: api_key, env: OLLAMA_API_KEY } }
# Local
- { id: ollama, name: Ollama (local), kind: openai-compatible, base_url: http://localhost:11434/v1, auth: { type: none }, models: [llama3.2, qwen2.5-coder:7b] }
- { id: lmstudio, name: LM Studio (local), kind: openai-compatible, base_url: http://localhost:1234/v1, auth: { type: none } }
```

- [ ] **Step 4: Correr, commit**

Run: `pnpm install && pnpm build && pnpm --filter @wizardingcode/shibaox-providers test && pnpm typecheck && pnpm lint`
```bash
git add packages/providers pnpm-lock.yaml
git commit -m "feat(providers): provider catalog and AI SDK registry"
```

---

### Task 4: `LlmClient` e servidor fake OpenAI-compatible

**Files:**
- Create: `packages/providers/src/llm-client.ts`, `packages/providers/src/testing/fake-openai.ts` (exportado em `./testing` para outros pacotes usarem nos testes), `packages/providers/test/llm-client.test.ts`
- Modify: `packages/providers/package.json` (`exports["./testing"]`), `src/index.ts`

**Interfaces:**
- Produces:
```ts
interface GenerateArgs { model: LanguageModel; system?: string; messages: ModelMessage[]; tools?: ToolSet; maxSteps?: number; output?: z.ZodType; signal?: AbortSignal }
interface GenerateResult<T = unknown> { text: string; output?: T; usage: { inputTokens: number; outputTokens: number }; steps: number }
class LlmClient { constructor(registry: ProviderRegistry); generate(ref: string, args: Omit<GenerateArgs,'model'>): Promise<GenerateResult & { cost?: number }> }
// testing
interface FakeTurn { content?: string; toolCalls?: { name: string; args: unknown }[] }
startFakeOpenAI(script: (req: { messages: unknown[]; tools?: unknown[] }, turn: number) => FakeTurn): Promise<{ baseURL: string; requests: unknown[]; close(): Promise<void> }>
```

- [ ] **Step 1: Teste (falha)**

`packages/providers/test/llm-client.test.ts`:
```ts
import { tool } from 'ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient, ProviderRegistry, type ProviderEntry } from '../src/index.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;
const entryFor = (baseURL: string): ProviderEntry => ({ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: baseURL, auth: { type: 'none' }, models: [], pricing: { m: { input_per_m: 1, output_per_m: 2 } }, verify: false });

describe('LlmClient over an OpenAI-compatible fake', () => {
  afterAll(async () => { await fake?.close(); });

  it('returns text and usage, and estimates cost', async () => {
    fake = await startFakeOpenAI(() => ({ content: 'hello there' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', { messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('hello there');
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.cost).toBeCloseTo((r.usage.inputTokens * 1 + r.usage.outputTokens * 2) / 1_000_000);
    await fake.close();
  });

  it('runs a tool call round-trip and stops at maxSteps', async () => {
    fake = await startFakeOpenAI((_req, turn) => (turn === 0 ? { toolCalls: [{ name: 'add', args: { a: 2, b: 3 } }] } : { content: 'the sum is 5' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', {
      messages: [{ role: 'user', content: 'add 2 and 3' }],
      tools: { add: tool({ description: 'add', inputSchema: z.object({ a: z.number(), b: z.number() }), execute: async ({ a, b }) => a + b }) },
      maxSteps: 3,
    });
    expect(r.text).toBe('the sum is 5');
    expect(r.steps).toBe(2);
    expect(fake.requests).toHaveLength(2);
    await fake.close();
  });

  it('returns a validated object with output', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"passed": true, "evidence": "ok"}' }));
    const client = new LlmClient(new ProviderRegistry([entryFor(fake.baseURL)], {}));
    const r = await client.generate('fake/m', { messages: [{ role: 'user', content: 'judge' }], output: z.object({ passed: z.boolean(), evidence: z.string() }) });
    expect(r.output).toEqual({ passed: true, evidence: 'ok' });
    await fake.close();
  });
});
```

- [ ] **Step 2: Implementar o fake**

`packages/providers/src/testing/fake-openai.ts`:
```ts
import { createServer } from 'node:http';

export interface FakeTurn { content?: string; toolCalls?: { name: string; args: unknown }[] }
export type FakeScript = (req: { messages: unknown[]; tools?: unknown[] }, turn: number) => FakeTurn;

export async function startFakeOpenAI(script: FakeScript) {
  const requests: unknown[] = [];
  let turn = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) { res.statusCode = 404; res.end('not found'); return; }
      const parsed = JSON.parse(body) as { messages: unknown[]; tools?: unknown[] };
      requests.push(parsed);
      const t = script(parsed, turn++);
      const message = t.toolCalls
        ? { role: 'assistant', content: null, tool_calls: t.toolCalls.map((c, i) => ({ id: `call_${turn}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
        : { role: 'assistant', content: t.content ?? '' };
      const promptTokens = Math.max(1, Math.ceil(body.length / 4));
      const completionTokens = Math.max(1, Math.ceil(JSON.stringify(message).length / 4));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: `chatcmpl-${turn}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'm', choices: [{ index: 0, message, finish_reason: t.toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```
Em `package.json`: `"exports": { ".": {...}, "./testing": { "types": "./dist/testing/fake-openai.d.ts", "import": "./dist/testing/fake-openai.js" } }`.

- [ ] **Step 3: Implementar o cliente**

`packages/providers/src/llm-client.ts`:
```ts
import { Output, generateText, isStepCount, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { ProviderRegistry } from './registry.js';

export interface GenerateArgs { model: LanguageModel; system?: string; messages: ModelMessage[]; tools?: ToolSet; maxSteps?: number; output?: z.ZodType; signal?: AbortSignal }
export interface GenerateResult<T = unknown> { text: string; output?: T; usage: { inputTokens: number; outputTokens: number }; steps: number }

export async function generate<T = unknown>(args: GenerateArgs): Promise<GenerateResult<T>> {
  const r = await generateText({
    model: args.model,
    system: args.system,
    messages: args.messages,
    tools: args.tools,
    stopWhen: isStepCount(args.maxSteps ?? 1),
    abortSignal: args.signal,
    output: args.output ? Output.object({ schema: args.output }) : undefined,
  });
  return {
    text: r.text,
    output: args.output ? (r.output as T) : undefined,
    usage: { inputTokens: r.usage.inputTokens ?? 0, outputTokens: r.usage.outputTokens ?? 0 },
    steps: r.steps.length,
  };
}

export class LlmClient {
  constructor(private readonly registry: ProviderRegistry) {}
  async generate<T = unknown>(ref: string, args: Omit<GenerateArgs, 'model'>): Promise<GenerateResult<T> & { cost?: number }> {
    const model = this.registry.model(ref);
    const r = await generate<T>({ ...args, model });
    return { ...r, cost: this.registry.estimateCost(ref, r.usage) };
  }
}
```
Se na versão instalada `generateText` não aceitar `output` com tools em simultâneo, `generate` chama sem `tools` quando `output` está definido (documentar). Se `r.usage.inputTokens` for um objeto (`{ total }`), usar `.total`.

- [ ] **Step 4: Correr, commit**

```bash
git add packages/providers
git commit -m "feat(providers): LlmClient over AI SDK and OpenAI-compatible fake server for tests"
```

---

### Task 5: `@wizardingcode/shibaox-jev` — cliente, fan-out, decider e check runner

**Files:**
- Create: `packages/jev/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/client.ts`, `src/decider.ts`, `src/check-runner.ts`, `src/testing/fake-jev.ts`
- Test: `packages/jev/test/client.test.ts`, `packages/jev/test/decider.test.ts`, `packages/jev/test/check-runner.test.ts`

**Interfaces:**
- Consumes: `@typesafe-ai/sdk` (`TypeSafeClient`, `choice`, `score`, `noul`), `Decider`, `DecisionRequest`, `CheckRunner`, `CheckContext` de `@wizardingcode/shibaox-core`, `Check`, `CheckResult` de `@wizardingcode/shibaox-schemas`.
- Produces:
```ts
class JevClient { constructor(opts?: { apiKey?: string; baseURL?: string; model?: string }); fanOut<Q extends Questions>(state: unknown, questions: Q): Promise<{ answers: SystemOneResult<Q>['answers']; usage: { inputTokens: number; outputTokens: number }; cost: number }> ; isConfigured(): boolean }
gateByConfidence(confidence: number, threshold: number, escalateBelow = 0.5): 'pass' | 'escalate' | 'fail'
class JevDecider implements Decider { constructor(client: JevClient, opts?: { threshold?: number; fallback?: Decider }) }
jevCheckRunner(client: JevClient, opts?: { escalate?: CheckRunner }): CheckRunner
truncateState(parts: { spec?: string; output?: string; diff?: string }, maxChars = 100_000): string
// testing
startFakeJev(script: (req: { state: unknown; questions: Record<string, { type: string }> }) => Record<string, unknown>): Promise<{ baseURL: string; requests: unknown[]; close(): Promise<void> }>
```
Custo do Jev: `$0.042` por milhão de tokens de entrada (spec); `cost = inputTokens / 1e6 * 0.042`.

- [ ] **Step 1: Testes (falham)**

`packages/jev/test/client.test.ts`:
```ts
import { choice, noul, score } from '@typesafe-ai/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { JevClient, gateByConfidence } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => { await fake?.close(); fake = undefined; });

describe('JevClient.fanOut', () => {
  it('sends state and questions in one call and maps usage to cost', async () => {
    fake = await startFakeJev(() => ({
      team: { type: 'choice', choice: 'engineering', confidence: 0.93, probabilities: { engineering: 0.93, marketing: 0.07 } },
      urgent: { type: 'noul', noul: 0.2 },
      quality: { type: 'score', score: 2, confidence: 0.8, legend: ['bad', 'ok', 'good'], probabilities: [0.1, 0.1, 0.8] },
    }));
    const client = new JevClient({ apiKey: 'k', baseURL: fake.baseURL });
    const r = await client.fanOut('Fix the payments bug', {
      team: choice('Which team', { engineering: 'code', marketing: 'campaigns' }),
      urgent: noul('The request is urgent'),
      quality: score('Quality', ['bad', 'ok', 'good']),
    });
    expect(r.answers.team.choice).toBe('engineering');
    expect(r.answers.urgent.noul).toBeCloseTo(0.2);
    expect(r.answers.quality.score).toBe(2);
    expect(fake.requests).toHaveLength(1);
    expect(r.cost).toBeCloseTo((r.usage.inputTokens / 1_000_000) * 0.042);
  });
  it('isConfigured reflects the api key', () => {
    expect(new JevClient({ apiKey: undefined, baseURL: 'http://x' }).isConfigured()).toBe(false);
  });
});

describe('gateByConfidence', () => {
  it('passes above threshold, escalates in the grey zone, fails below', () => {
    expect(gateByConfidence(0.9, 0.8)).toBe('pass');
    expect(gateByConfidence(0.6, 0.8)).toBe('escalate');
    expect(gateByConfidence(0.3, 0.8)).toBe('fail');
  });
});
```

`packages/jev/test/decider.test.ts`:
```ts
import { describe, expect, it, afterEach } from 'vitest';
import { JevClient, JevDecider } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => { await fake?.close(); });
const req = { runId: 'r', nodeId: 'judge', by: 'team-leader', question: 'Ready to ship?', options: ['ship', 'rework'], context: { input: { spec: 'x' }, previousOutputs: { implement: { did: 'it' } } } };

describe('JevDecider', () => {
  it('returns the Jev choice with confidence and cost', async () => {
    fake = await startFakeJev(() => ({ decision: { type: 'choice', choice: 'ship', confidence: 0.91, probabilities: { ship: 0.91, rework: 0.09 } } }));
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await d.decide(req);
    expect(r).toMatchObject({ choice: 'ship', confidence: 0.91 });
    expect(r.cost?.usd).toBeGreaterThan(0);
    const sent = fake.requests[0] as { questions: { decision: { criteria: Record<string, string> } } };
    expect(Object.keys(sent.questions.decision.criteria)).toEqual(['ship', 'rework']);
  });
  it('falls back to another decider when confidence is below the threshold', async () => {
    fake = await startFakeJev(() => ({ decision: { type: 'choice', choice: 'ship', confidence: 0.55, probabilities: { ship: 0.55, rework: 0.45 } } }));
    const fallback = { decide: async () => ({ choice: 'rework', confidence: 1 }) };
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), { threshold: 0.8, fallback });
    expect((await d.decide(req)).choice).toBe('rework');
  });
  it('without a fallback, low confidence still returns the Jev choice but flags it', async () => {
    fake = await startFakeJev(() => ({ decision: { type: 'choice', choice: 'ship', confidence: 0.55, probabilities: { ship: 0.55, rework: 0.45 } } }));
    const d = new JevDecider(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), { threshold: 0.8 });
    const r = await d.decide(req);
    expect(r.choice).toBe('ship');
    expect(r.confidence).toBe(0.55);
  });
});
```

`packages/jev/test/check-runner.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { JevClient, jevCheckRunner, truncateState } from '../src/index.js';
import { startFakeJev } from '../src/testing/fake-jev.js';

let fake: Awaited<ReturnType<typeof startFakeJev>> | undefined;
afterEach(async () => { await fake?.close(); });
const ctx = { runId: 'r', nodeId: 'qa', workspace: process.cwd(), state: { runId: 'r', workflow: 'w', input: { spec: 'add /health' }, workspace: '', status: 'running', nodes: { implement: { status: 'completed', attempts: 1, output: { summary: 'added route' } } }, spentUsd: 0, budgetWarned: false, pendingHumans: [] }, log: () => {} } as const;

describe('jevCheckRunner', () => {
  it('passes a noul check above threshold with confidence and cost', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.92 } }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run({ name: 'spec', type: 'jev', question: 'The output implements the spec', kind: 'noul', threshold: 0.8 }, ctx as never);
    expect(r).toMatchObject({ name: 'spec', type: 'jev', passed: true, confidence: 0.92 });
    expect(r.cost?.usd).toBeGreaterThan(0);
    expect(r.evidence).toContain('0.92');
  });
  it('fails below the fail line and escalates in the grey zone when an escalation runner exists', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.65 } }));
    const escalate = async () => ({ name: 'spec', type: 'judge' as const, passed: true, skipped: false, evidence: 'judge says ok' });
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }), { escalate });
    const r = await run({ name: 'spec', type: 'jev', question: 'q', kind: 'noul', threshold: 0.8 }, ctx as never);
    expect(r.passed).toBe(true);
    expect(r.evidence).toContain('escalated');
  });
  it('never passes on low confidence without escalation', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'noul', noul: 0.65 } }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run({ name: 'spec', type: 'jev', question: 'q', kind: 'noul', threshold: 0.8 }, ctx as never);
    expect(r.passed).toBe(false);
    expect(r.suggestion).toContain('judge');
  });
  it('score checks pass when the normalised score meets the threshold', async () => {
    fake = await startFakeJev(() => ({ check: { type: 'score', score: 2, confidence: 0.9, legend: ['bad', 'ok', 'good'], probabilities: [0, 0.1, 0.9] } }));
    const run = jevCheckRunner(new JevClient({ apiKey: 'k', baseURL: fake.baseURL }));
    const r = await run({ name: 'q', type: 'jev', question: 'Quality', kind: 'score', threshold: 0.8 }, ctx as never);
    expect(r.passed).toBe(true);
  });
});

describe('truncateState', () => {
  it('keeps spec first, then output, then diff, within the limit', () => {
    const s = truncateState({ spec: 'S'.repeat(50), output: 'O'.repeat(50), diff: 'D'.repeat(50) }, 120);
    expect(s.startsWith('## spec')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(120);
    expect(s).toContain('SSSS');
    expect(s).not.toContain('DDDD');
  });
});
```

- [ ] **Step 2: Implementar**

`packages/jev/src/testing/fake-jev.ts`:
```ts
import { createServer } from 'node:http';

export async function startFakeJev(script: (req: { state: unknown; questions: Record<string, { type: string }> }) => Record<string, unknown>) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url?.includes('/systemone')) { res.statusCode = 404; res.end(); return; }
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const answers = script(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: Math.max(1, Math.ceil(body.length / 4)), output_tokens: 0 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { baseURL: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}
```
Se o SDK anexar um prefixo diferente ao `baseURL` (por exemplo `/v1/systemone`), o fake aceita qualquer URL que contenha `/systemone`.

`packages/jev/src/client.ts`:
```ts
import { TypeSafeClient, type SystemOneResult } from '@typesafe-ai/sdk';

export const JEV_INPUT_USD_PER_M = 0.042;
type Questions = Parameters<TypeSafeClient['systemOne']>[0]['questions'];

export class JevClient {
  private readonly client: TypeSafeClient;
  private readonly apiKey: string | undefined;
  constructor(opts: { apiKey?: string; baseURL?: string; model?: string } = {}) {
    this.apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.client = new TypeSafeClient({ apiKey: this.apiKey ?? 'missing', baseURL: opts.baseURL, defaultModel: opts.model });
  }
  isConfigured(): boolean { return Boolean(this.apiKey); }
  async fanOut<Q extends Questions>(state: unknown, questions: Q) {
    if (!this.isConfigured()) throw new Error('Jev is not configured: set TYPESAFE_API_KEY');
    const r = (await this.client.systemOne({ state: state as never, questions })) as SystemOneResult<Q>;
    const usage = { inputTokens: r.usage.input_tokens, outputTokens: r.usage.output_tokens };
    return { answers: r.answers, usage, cost: (usage.inputTokens / 1_000_000) * JEV_INPUT_USD_PER_M };
  }
}

export function gateByConfidence(confidence: number, threshold: number, escalateBelow = 0.5): 'pass' | 'escalate' | 'fail' {
  if (confidence >= threshold) return 'pass';
  if (confidence >= escalateBelow) return 'escalate';
  return 'fail';
}

export function truncateState(parts: { spec?: string; output?: string; diff?: string }, maxChars = 100_000): string {
  const sections: [string, string | undefined][] = [['spec', parts.spec], ['output', parts.output], ['diff', parts.diff]];
  let out = '';
  for (const [name, text] of sections) {
    if (!text) continue;
    const header = `## ${name}\n`;
    const room = maxChars - out.length - header.length - 1;
    if (room <= 0) break;
    out += `${header}${text.length > room ? `${text.slice(0, room - 1)}…` : text}\n`;
  }
  return out;
}
```
Se o tipo `Questions` não for exportado desta forma pelo SDK, definir localmente `type Questions = Record<string, ReturnType<typeof choice> | ReturnType<typeof score> | ReturnType<typeof noul>>`.

`packages/jev/src/decider.ts`:
```ts
import type { Decider, Decision, DecisionRequest } from '@wizardingcode/shibaox-core';
import { choice } from '@typesafe-ai/sdk';
import { type JevClient, gateByConfidence } from './client.js';

export class JevDecider implements Decider {
  constructor(private readonly client: JevClient, private readonly opts: { threshold?: number; fallback?: Decider } = {}) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const criteria = Object.fromEntries(req.options.map((o) => [o, o]));
    const state = JSON.stringify({ question: req.question, input: req.context.input, previousOutputs: req.context.previousOutputs, lastGateReport: req.context.lastGateReport });
    const r = await this.client.fanOut(state, { decision: choice(req.question || 'Choose the next step', criteria) });
    const a = r.answers.decision;
    const cost = { usd: r.cost, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    const verdict = gateByConfidence(a.confidence, this.opts.threshold ?? 0.8);
    if (verdict !== 'pass' && this.opts.fallback) {
      const f = await this.opts.fallback.decide(req);
      return { ...f, cost: f.cost ? { ...f.cost, usd: f.cost.usd + cost.usd } : cost };
    }
    return { choice: a.choice, confidence: a.confidence, cost };
  }
}
```

`packages/jev/src/check-runner.ts`:
```ts
import type { CheckContext, CheckRunner } from '@wizardingcode/shibaox-core';
import type { CheckResult } from '@wizardingcode/shibaox-schemas';
import { noul, score } from '@typesafe-ai/sdk';
import { type JevClient, gateByConfidence, truncateState } from './client.js';

function stateFor(ctx: CheckContext): string {
  const spec = String(ctx.state.input.spec ?? JSON.stringify(ctx.state.input));
  const output = JSON.stringify(Object.fromEntries(Object.entries(ctx.state.nodes).filter(([, n]) => n.output !== undefined).map(([id, n]) => [id, n.output])));
  return truncateState({ spec, output });
}

export function jevCheckRunner(client: JevClient, opts: { escalate?: CheckRunner } = {}): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'jev') throw new Error('jevCheckRunner got a non-jev check');
    const state = stateFor(ctx);
    const q = check.kind === 'score' ? score(check.question, ['fails', 'partially', 'fully']) : noul(check.question);
    const r = await client.fanOut(state, { check: q });
    const a = r.answers.check as { noul?: number; score?: number; confidence?: number };
    const confidence = check.kind === 'score' ? (a.score ?? 0) / 2 : (a.noul ?? 0);
    const cost = { usd: r.cost, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    const verdict = gateByConfidence(confidence, check.threshold);
    const base: CheckResult = { name: check.name, type: 'jev', passed: verdict === 'pass', skipped: false, confidence, cost, evidence: `jev ${check.kind} = ${confidence.toFixed(2)} (threshold ${check.threshold})` };
    if (verdict === 'escalate' && opts.escalate) {
      const e = await opts.escalate({ name: check.name, type: 'judge', role: 'team-leader', rubric: check.question }, ctx);
      return { ...e, name: check.name, type: 'jev', confidence, cost: e.cost ? { ...e.cost, usd: e.cost.usd + cost.usd } : cost, evidence: `escalated to judge (jev ${confidence.toFixed(2)}): ${e.evidence}` };
    }
    if (verdict !== 'pass') return { ...base, suggestion: verdict === 'escalate' ? 'Confidence in the grey zone: configure a judge runner to escalate, or improve the output' : 'Address the question in the check and re-run' };
    return base;
  };
}
```
`src/index.ts` exporta client, decider, check-runner. `package.json` com deps `@typesafe-ai/sdk ^0.6.0`, `@wizardingcode/shibaox-core`, `@wizardingcode/shibaox-schemas`; `exports["./testing"]` para o fake.

- [ ] **Step 3: Correr, commit**

```bash
git add packages/jev pnpm-lock.yaml
git commit -m "feat(jev): TypeSafe client wrapper, fan-out, JevDecider and jev check runner"
```

---

### Task 6: Router `resolveModel` (core) e `judgeCheckRunner` + `LeadDecider` (providers)

**Files:**
- Create: `packages/core/src/run/router.ts` (+ export), `packages/providers/src/judge.ts`, `packages/providers/src/lead-decider.ts` (+ exports)
- Test: `packages/core/test/router.test.ts`, `packages/providers/test/judge.test.ts`

**Interfaces:**
- Produces (core):
```ts
type ModelResolution = { kind: 'direct'; ref: string; provider: string; model: string } | { kind: 'runtime'; runtime: string; model?: string };
interface RouterProvider { id: string; via_runtime?: string; configured: boolean }
resolveModel(args: { role: Role; models: Models; providers: RouterProvider[]; runtimes: string[]; defaultAdapter?: string }): { resolution: ModelResolution; warnings: string[] }
```
Regras: (1) `defaultAdapter` (flag da CLI) vence tudo: `mock` → `{ kind: 'runtime', runtime: 'mock' }`; `direct` → resolve o ref abaixo e devolve `direct`; outro → `{ kind: 'runtime', runtime: <flag>, model }`. (2) Sem flag: `models.roles[role.role]?.model` ou `models.tiers[role.model_tier]` dá o ref `<provider>/<model>`; sem ref → erro `no model configured for tier "<tier>" (set models.yaml tiers.<tier>)`. (3) Se o provider tem `via_runtime` → `{ kind: 'runtime', runtime: via_runtime, model }`. (4) Senão, se `models.roles[role].runtime ?? role.runtime` é um runtime registado E o provider é `anthropic` E runtime é `claude-code` → runtime (Claude Code só fala Anthropic); noutro caso → `direct` e, se o papel pedia um runtime, `warnings` recebe `role "<r>" prefers runtime "<x>" but model "<ref>" is a direct provider; using direct`. (5) Provider não configurado → erro claro com as env vars em falta (usa `configured` do `RouterProvider`; a mensagem vem da CLI).
- Produces (providers): `judgeCheckRunner(client: LlmClient, ref: string): CheckRunner` — `generate` com `output: z.object({ passed, evidence, suggestion? })`, system prompt de revisor, estado como no Jev; `CheckResult { type: 'judge', passed, evidence, suggestion, cost }`. `LeadDecider implements Decider` — `generate` com `output: z.object({ choice: z.enum(options), reasoning })`.

- [ ] **Step 1: Testes (falham)**

`packages/core/test/router.test.ts`:
```ts
import { ModelsSchema, RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { resolveModel } from '../src/index.js';

const providers = [
  { id: 'anthropic', configured: true }, { id: 'anthropic-subscription', via_runtime: 'claude-code', configured: true },
  { id: 'ollama', configured: true }, { id: 'openrouter', configured: false },
];
const models = ModelsSchema.parse({ tiers: { strong: 'anthropic/claude-sonnet-5', cheap: 'ollama/llama3.2' }, roles: { researcher: { model: 'anthropic-subscription/claude-sonnet-5' } } });
const runtimes = ['claude-code', 'mock'];

describe('resolveModel', () => {
  it('maps a tier to a direct provider', () => {
    const r = resolveModel({ role: RoleSchema.parse({ role: 'analyst', model_tier: 'cheap', runtime: 'direct' }), models, providers, runtimes });
    expect(r.resolution).toEqual({ kind: 'direct', ref: 'ollama/llama3.2', provider: 'ollama', model: 'llama3.2' });
  });
  it('routes via_runtime providers to their runtime', () => {
    const r = resolveModel({ role: RoleSchema.parse({ role: 'researcher' }), models, providers, runtimes });
    expect(r.resolution).toEqual({ kind: 'runtime', runtime: 'claude-code', model: 'claude-sonnet-5' });
  });
  it('keeps claude-code for anthropic models when the role prefers it, otherwise goes direct with a warning', () => {
    const a = resolveModel({ role: RoleSchema.parse({ role: 'backend', model_tier: 'strong', runtime: 'claude-code' }), models, providers, runtimes });
    expect(a.resolution).toEqual({ kind: 'runtime', runtime: 'claude-code', model: 'claude-sonnet-5' });
    const b = resolveModel({ role: RoleSchema.parse({ role: 'backend', model_tier: 'cheap', runtime: 'claude-code' }), models, providers, runtimes });
    expect(b.resolution.kind).toBe('direct');
    expect(b.warnings[0]).toContain('prefers runtime "claude-code"');
  });
  it('the CLI adapter flag wins', () => {
    expect(resolveModel({ role: RoleSchema.parse({ role: 'x' }), models, providers, runtimes, defaultAdapter: 'mock' }).resolution).toEqual({ kind: 'runtime', runtime: 'mock' });
  });
  it('errors clearly on a missing tier or an unconfigured provider', () => {
    expect(() => resolveModel({ role: RoleSchema.parse({ role: 'x', model_tier: 'local' }), models, providers, runtimes })).toThrow(/tiers.local/);
    const m2 = ModelsSchema.parse({ tiers: { strong: 'openrouter/openai/gpt-5' } });
    expect(() => resolveModel({ role: RoleSchema.parse({ role: 'x' }), models: m2, providers, runtimes })).toThrow(/openrouter.*not configured/);
  });
});
```

`packages/providers/test/judge.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { LeadDecider, LlmClient, ProviderRegistry, judgeCheckRunner } from '../src/index.js';
import { startFakeOpenAI } from '../src/testing/fake-openai.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
afterEach(async () => { await fake?.close(); });
const reg = (baseURL: string) => new ProviderRegistry([{ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: baseURL, auth: { type: 'none' }, models: [], pricing: {}, verify: false }], {});
const ctx = { runId: 'r', nodeId: 'qa', workspace: process.cwd(), state: { runId: 'r', workflow: 'w', input: { spec: 'add /health' }, workspace: '', status: 'running', nodes: {}, spentUsd: 0, budgetWarned: false, pendingHumans: [] }, log: () => {} } as const;

describe('judgeCheckRunner', () => {
  it('turns the structured verdict into a CheckResult', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"passed": false, "evidence": "no tests", "suggestion": "add a test"}' }));
    const run = judgeCheckRunner(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await run({ name: 'review', type: 'judge', role: 'team-leader', rubric: 'Tests must exist' }, ctx as never);
    expect(r).toMatchObject({ type: 'judge', passed: false, evidence: 'no tests', suggestion: 'add a test' });
    const sent = fake.requests[0] as { messages: { role: string; content: string }[] };
    expect(sent.messages.map((m) => m.content).join('\n')).toContain('Tests must exist');
  });
});

describe('LeadDecider', () => {
  it('chooses among the node options', async () => {
    fake = await startFakeOpenAI(() => ({ content: '{"choice": "rework", "reasoning": "flaky"}' }));
    const d = new LeadDecider(new LlmClient(reg(fake.baseURL)), 'fake/m');
    const r = await d.decide({ runId: 'r', nodeId: 'judge', by: 'team-leader', question: 'Ready?', options: ['ship', 'rework'], context: { input: {}, previousOutputs: {} } });
    expect(r.choice).toBe('rework');
  });
});
```

- [ ] **Step 2: Implementar**

`packages/core/src/run/router.ts`:
```ts
import type { Models, Role } from '@wizardingcode/shibaox-schemas';

export type ModelResolution = { kind: 'direct'; ref: string; provider: string; model: string } | { kind: 'runtime'; runtime: string; model?: string };
export interface RouterProvider { id: string; via_runtime?: string; configured: boolean }

function splitRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  if (i <= 0 || i === ref.length - 1) throw new Error(`model ref "${ref}" must look like <provider>/<model>`);
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function resolveModel(args: { role: Role; models: Models; providers: RouterProvider[]; runtimes: string[]; defaultAdapter?: string }): { resolution: ModelResolution; warnings: string[] } {
  const warnings: string[] = [];
  const override = args.models.roles[args.role.role];
  if (args.defaultAdapter && args.defaultAdapter !== 'direct') return { resolution: { kind: 'runtime', runtime: args.defaultAdapter, model: override?.model ? splitRef(override.model).model : undefined }, warnings };
  const ref = override?.model ?? args.models.tiers[args.role.model_tier];
  if (!ref) throw new Error(`no model configured for tier "${args.role.model_tier}" (set models.yaml tiers.${args.role.model_tier})`);
  const { provider, model } = splitRef(ref);
  const p = args.providers.find((x) => x.id === provider);
  if (!p) throw new Error(`unknown provider "${provider}" in model ref "${ref}"`);
  if (p.via_runtime) return { resolution: { kind: 'runtime', runtime: p.via_runtime, model }, warnings };
  if (!p.configured) throw new Error(`provider "${provider}" is not configured (run: shibaox providers test ${provider})`);
  const preferred = override?.runtime ?? args.role.runtime;
  if (args.defaultAdapter !== 'direct' && preferred === 'claude-code' && provider === 'anthropic' && args.runtimes.includes('claude-code')) {
    return { resolution: { kind: 'runtime', runtime: 'claude-code', model }, warnings };
  }
  if (args.defaultAdapter !== 'direct' && preferred !== 'direct' && args.runtimes.includes(preferred)) {
    warnings.push(`role "${args.role.role}" prefers runtime "${preferred}" but model "${ref}" is a direct provider; using direct`);
  }
  return { resolution: { kind: 'direct', ref, provider, model }, warnings };
}
```
`RoleSchema.runtime` default continua `'claude-code'`; `'direct'` é um valor válido (string livre).

`packages/providers/src/judge.ts`:
```ts
import type { CheckContext, CheckRunner } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import type { LlmClient } from './llm-client.js';

const Verdict = z.object({ passed: z.boolean(), evidence: z.string(), suggestion: z.string().optional() });
export const JUDGE_SYSTEM = 'You are a strict but fair technical reviewer. Judge the work against the rubric using only the provided context. Answer with the JSON object requested.';

export function judgeContext(ctx: CheckContext): string {
  const outputs = Object.fromEntries(Object.entries(ctx.state.nodes).filter(([, n]) => n.output !== undefined).map(([id, n]) => [id, n.output]));
  return `## request\n${JSON.stringify(ctx.state.input)}\n\n## outputs\n${JSON.stringify(outputs).slice(0, 60_000)}\n\n## last gate report\n${JSON.stringify(ctx.state.lastGateReport ?? null).slice(0, 20_000)}`;
}

export function judgeCheckRunner(client: LlmClient, ref: string): CheckRunner {
  return async (check, ctx) => {
    if (check.type !== 'judge') throw new Error('judgeCheckRunner got a non-judge check');
    const r = await client.generate<z.infer<typeof Verdict>>(ref, { system: JUDGE_SYSTEM, messages: [{ role: 'user', content: `Rubric:\n${check.rubric}\n\n${judgeContext(ctx)}` }], output: Verdict });
    const v = r.output ?? { passed: false, evidence: 'judge returned no structured verdict' };
    return { name: check.name, type: 'judge', passed: v.passed, skipped: false, evidence: v.evidence, suggestion: v.suggestion, cost: { usd: r.cost ?? 0, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } };
  };
}
```

`packages/providers/src/lead-decider.ts`:
```ts
import type { Decider, Decision, DecisionRequest } from '@wizardingcode/shibaox-core';
import { z } from 'zod';
import type { LlmClient } from './llm-client.js';

export class LeadDecider implements Decider {
  constructor(private readonly client: LlmClient, private readonly ref: string) {}
  async decide(req: DecisionRequest): Promise<Decision> {
    const schema = z.object({ choice: z.enum(req.options as [string, ...string[]]), reasoning: z.string() });
    const r = await this.client.generate<z.infer<typeof schema>>(this.ref, {
      system: 'You are the team lead. Decide the next step for this run. Answer with the JSON object requested.',
      messages: [{ role: 'user', content: `Question: ${req.question}\nOptions: ${req.options.join(', ')}\n\nContext:\n${JSON.stringify(req.context).slice(0, 60_000)}` }],
      output: schema,
    });
    const choice = r.output?.choice ?? req.options[0]!;
    return { choice, confidence: r.output ? 1 : 0, cost: { usd: r.cost ?? 0, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } };
  }
}
```

- [ ] **Step 3: Correr, commit**

```bash
git add packages/core packages/providers
git commit -m "feat(core,providers): model router, LLM judge check runner and lead decider"
```

---

### Task 7: `@wizardingcode/shibaox-adapter-direct` — runtime direto com ferramentas restritas ao workspace

**Files:**
- Create: `packages/adapter-direct/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/adapter.ts`, `src/tools.ts`, `src/safe-path.ts`
- Test: `packages/adapter-direct/test/safe-path.test.ts`, `packages/adapter-direct/test/adapter.test.ts`

**Interfaces:**
- Consumes: `RuntimeAdapter`, `TaskJob`, `ExecutionContext`, `RuntimeEvent`, `runCommand` (core); `LlmClient`/`generate`, `ProviderRegistry` (providers); `startFakeOpenAI` (providers/testing).
- Produces:
```ts
interface DirectAdapterOptions { registry: ProviderRegistry; resolveRef: (job: TaskJob) => string; maxSteps?: number /* default 12 */; commandTimeoutMs?: number /* default 120000 */; maxFileBytes?: number /* default 200_000 */ }
class DirectAdapter implements RuntimeAdapter { readonly id = 'direct'; constructor(opts: DirectAdapterOptions); capabilities(); run(job, ctx): AsyncIterable<RuntimeEvent> }
safePath(workspace: string, rel: string): string   // throws `path escapes workspace` for ../, absolute paths outside, symlinks outside
buildTools(args: { workspace: string; role: Role; ctx: ExecutionContext; emit: (e: RuntimeEvent) => void; onFinish: (output: unknown, summary: string) => void; commandTimeoutMs: number; maxFileBytes: number }): ToolSet
```
Comportamento de `run`: system prompt = prompt do papel (`role.system_prompt` lido do org root se for um caminho, senão `role.description`) + regras fixas (trabalhar só no workspace, terminar com `finish`); mensagem do utilizador = instrução + `input` + `previousOutputs` + `lastGateReport` (JSON, truncado a 60k chars). Loop `generate` com `tools`, `maxSteps`, `signal`. Se `finish` foi chamada → `result { output, summary, cost }`; se o modelo terminou sem `finish` → `result { output: { text }, summary: text.slice(0, 200), cost }` (Review Focus 3). Erros → `error`. `run_command` só aceita comandos cujo primeiro token está em `role.tools` (se `role.tools` vazio, nenhum comando é permitido) e corre com `runCommand` no workspace.

- [ ] **Step 1: Testes (falham)**

`packages/adapter-direct/test/safe-path.test.ts`:
```ts
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safePath } from '../src/index.js';

describe('safePath', () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  it('accepts relative paths inside the workspace', () => {
    expect(safePath(ws, 'src/a.ts')).toBe(join(ws, 'src/a.ts'));
  });
  it('rejects ../ escapes and absolute paths outside', () => {
    expect(() => safePath(ws, '../etc/passwd')).toThrow(/escapes workspace/);
    expect(() => safePath(ws, '/etc/passwd')).toThrow(/escapes workspace/);
  });
  it('rejects a symlink pointing outside', () => {
    const outside = mkdtempSync(join(tmpdir(), 'out-'));
    writeFileSync(join(outside, 'secret'), 'x');
    mkdirSync(join(ws, 'links'), { recursive: true });
    symlinkSync(outside, join(ws, 'links/out'));
    expect(() => safePath(ws, 'links/out/secret')).toThrow(/escapes workspace/);
  });
});
```

`packages/adapter-direct/test/adapter.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRun, type RuntimeEvent, type TaskJob } from '@wizardingcode/shibaox-core';
import { ProviderRegistry } from '@wizardingcode/shibaox-providers';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { afterEach, describe, expect, it } from 'vitest';
import { DirectAdapter } from '../src/index.js';

let fake: Awaited<ReturnType<typeof startFakeOpenAI>> | undefined;
afterEach(async () => { await fake?.close(); });
const registry = (baseURL: string) => new ProviderRegistry([{ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: baseURL, auth: { type: 'none' }, models: [], pricing: {}, verify: false }], {});
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });
const jobFor = (workspace: string, tools: string[] = ['echo']): TaskJob => ({ runId: 'r', nodeId: 'implement', role: RoleSchema.parse({ role: 'backend', tools, system_prompt: undefined, description: 'Implements changes' }), instruction: 'create hello.txt with hi', input: { spec: 'x' }, workspace, context: { previousOutputs: {} } });

describe('DirectAdapter', () => {
  it('writes a file through the tool, then finishes with a typed output', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((_r, turn) => turn === 0
      ? { toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hi' } }] }
      : { toolCalls: [{ name: 'finish', args: { output: { files: ['hello.txt'] }, summary: 'wrote hello.txt' } }] });
    const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(jobFor(ws), ctx())) events.push(e);
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi');
    expect(events.map((e) => e.type)).toEqual(['started', 'tool_use', 'file_changed', 'tool_result', 'tool_use', 'tool_result', 'result']);
    const result = events.at(-1);
    expect(result?.type === 'result' && result.output).toEqual({ files: ['hello.txt'] });
  });
  it('finishes with the text when the model never calls finish', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => ({ content: 'Nothing to do here.' }));
    const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    expect(r.output).toEqual({ text: 'Nothing to do here.' });
    expect(r.summary).toContain('Nothing to do');
  });
  it('refuses paths outside the workspace and reports it back to the model', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0) return { toolCalls: [{ name: 'write_file', args: { path: '../evil.txt', content: 'x' } }] };
      const last = JSON.stringify(req.messages.at(-1));
      return { content: last.includes('escapes workspace') ? 'blocked' : 'not blocked' };
    });
    const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' });
    const r = await collectRun(adapter, jobFor(ws), ctx());
    expect(existsSync(join(ws, '../evil.txt'))).toBe(false);
    expect(r.output).toEqual({ text: 'blocked' });
  });
  it('only runs commands allowed by role.tools', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI((req, turn) => {
      if (turn === 0) return { toolCalls: [{ name: 'run_command', args: { command: 'rm -rf /' } }, { name: 'run_command', args: { command: 'echo ok' } }] };
      return { content: JSON.stringify(req.messages.slice(-2)) };
    });
    const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' });
    const r = await collectRun(adapter, jobFor(ws, ['echo']), ctx());
    const text = String((r.output as { text: string }).text);
    expect(text).toContain('not allowed');
    expect(text).toContain('"exitCode":0');
  });
  it('aborts when the signal fires', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-'));
    fake = await startFakeOpenAI(() => new Promise((r) => setTimeout(() => r({ content: 'late' }), 2_000)) as never);
    const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(collectRun(adapter, jobFor(ws), { signal: ac.signal, log: () => {} })).rejects.toThrow();
  });
});
```
Nota: para o último teste, `startFakeOpenAI` deve aceitar um script que devolve uma `Promise<FakeTurn>` (ajustar o tipo `FakeScript` para `FakeTurn | Promise<FakeTurn>` e `await` no servidor).

- [ ] **Step 2: Implementar**

`packages/adapter-direct/src/safe-path.ts`:
```ts
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function safePath(workspace: string, rel: string): string {
  const root = realpathSync(workspace);
  const target = resolve(root, rel);
  const check = (p: string) => {
    const r = relative(root, p);
    if (r === '' || (!r.startsWith('..') && !isAbsolute(r))) return;
    throw new Error(`path "${rel}" escapes workspace`);
  };
  check(target);
  // resolve symlinks on the deepest existing ancestor
  let probe = target;
  while (!existsSync(probe)) probe = dirname(probe);
  check(realpathSync(probe));
  return target;
}
```

`packages/adapter-direct/src/tools.ts`:
```ts
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type ExecutionContext, type RuntimeEvent, runCommand } from '@wizardingcode/shibaox-core';
import type { Role } from '@wizardingcode/shibaox-schemas';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { safePath } from './safe-path.js';

export interface ToolArgs { workspace: string; role: Role; ctx: ExecutionContext; emit: (e: RuntimeEvent) => void; onFinish: (output: unknown, summary: string) => void; commandTimeoutMs: number; maxFileBytes: number }

function walk(dir: string, root: string, out: string[], limit: number): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || out.length >= limit) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, out, limit);
    else out.push(relative(root, full));
  }
}

export function buildTools(a: ToolArgs): ToolSet {
  const guarded = <I, O>(name: string, fn: (input: I) => Promise<O> | O) => async (input: I): Promise<O | { error: string }> => {
    a.emit({ type: 'tool_use', name, input });
    try {
      const output = await fn(input);
      a.emit({ type: 'tool_result', name, output });
      return output;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      a.emit({ type: 'tool_result', name, output: { error } });
      return { error };
    }
  };
  const allowed = new Set(a.role.tools);
  return {
    list_files: tool({ description: 'List files in the workspace (relative paths), up to 500 entries', inputSchema: z.object({ subdir: z.string().default('.') }), execute: guarded('list_files', ({ subdir }) => { const out: string[] = []; walk(safePath(a.workspace, subdir), a.workspace, out, 500); return { files: out }; }) }),
    read_file: tool({ description: 'Read a UTF-8 file from the workspace', inputSchema: z.object({ path: z.string() }), execute: guarded('read_file', ({ path }) => { const p = safePath(a.workspace, path); const size = statSync(p).size; if (size > a.maxFileBytes) throw new Error(`file too large (${size} bytes)`); return { content: readFileSync(p, 'utf8') }; }) }),
    write_file: tool({ description: 'Create or overwrite a UTF-8 file in the workspace', inputSchema: z.object({ path: z.string(), content: z.string() }), execute: guarded('write_file', ({ path, content }) => { const p = safePath(a.workspace, path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); a.emit({ type: 'file_changed', path }); return { ok: true, bytes: Buffer.byteLength(content) }; }) }),
    run_command: tool({ description: `Run a shell command in the workspace. Allowed programs: ${[...allowed].join(', ') || 'none'}`, inputSchema: z.object({ command: z.string() }), execute: guarded('run_command', async ({ command }) => { const first = command.trim().split(/\s+/)[0] ?? ''; if (!allowed.has(first)) throw new Error(`command "${first}" is not allowed for role ${a.role.role}`); const r = await runCommand({ command, cwd: a.workspace, timeoutMs: a.commandTimeoutMs }); return { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout.slice(-8000), stderr: r.stderr.slice(-8000) }; }) }),
    finish: tool({ description: 'Finish the task. Call exactly once when done, with the structured output and a one-line summary.', inputSchema: z.object({ output: z.unknown(), summary: z.string() }), execute: guarded('finish', ({ output, summary }) => { a.onFinish(output, summary); return { ok: true }; }) }),
  };
}
```

`packages/adapter-direct/src/adapter.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Capability, ExecutionContext, RuntimeAdapter, RuntimeEvent, TaskJob } from '@wizardingcode/shibaox-core';
import { type ProviderRegistry, generate } from '@wizardingcode/shibaox-providers';
import { buildTools } from './tools.js';

export interface DirectAdapterOptions { registry: ProviderRegistry; resolveRef: (job: TaskJob) => string; orgRoot?: string; maxSteps?: number; commandTimeoutMs?: number; maxFileBytes?: number }

const RULES = 'Rules: work only inside the workspace using the tools; never assume files exist without reading them; when the task is done call finish(output, summary) exactly once. If nothing needs to change, call finish with an explanation.';

export class DirectAdapter implements RuntimeAdapter {
  readonly id = 'direct';
  constructor(private readonly opts: DirectAdapterOptions) {}
  capabilities(): Capability[] { return ['write-code', 'run-tests', 'shell']; }

  private systemPrompt(job: TaskJob): string {
    let prompt = job.role.description ?? `You are the ${job.role.role}.`;
    if (job.role.system_prompt && this.opts.orgRoot) {
      const p = join(this.opts.orgRoot, job.role.system_prompt);
      if (existsSync(p)) prompt = readFileSync(p, 'utf8');
    }
    return `${prompt}\n\n${RULES}`;
  }

  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    const queue: RuntimeEvent[] = [];
    let finished: { output: unknown; summary: string } | undefined;
    const tools = buildTools({ workspace: job.workspace, role: job.role, ctx, emit: (e) => queue.push(e), onFinish: (output, summary) => { finished = { output, summary }; }, commandTimeoutMs: this.opts.commandTimeoutMs ?? 120_000, maxFileBytes: this.opts.maxFileBytes ?? 200_000 });
    const ref = this.opts.resolveRef(job);
    const user = `Task: ${job.instruction}\n\nInput: ${JSON.stringify(job.input)}\n\nPrevious outputs: ${JSON.stringify(job.context.previousOutputs).slice(0, 60_000)}\n\nLast gate report: ${JSON.stringify(job.context.lastGateReport ?? null).slice(0, 20_000)}`;
    let result: Awaited<ReturnType<typeof generate>>;
    try {
      const pending = generate({ model: this.opts.registry.model(ref), system: this.systemPrompt(job), messages: [{ role: 'user', content: user }], tools, maxSteps: this.opts.maxSteps ?? 12, signal: ctx.signal });
      // drain tool events while the model works
      while (true) {
        const raced = await Promise.race([pending.then((r) => ({ done: true as const, r })), new Promise<{ done: false }>((res) => setTimeout(() => res({ done: false }), 25))]);
        while (queue.length) yield queue.shift() as RuntimeEvent;
        if (raced.done) { result = raced.r; break; }
      }
    } catch (e) {
      while (queue.length) yield queue.shift() as RuntimeEvent;
      yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      return;
    }
    const usage = result.usage;
    const cost = { usd: this.opts.registry.estimateCost(ref, usage) ?? 0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    if (finished) yield { type: 'result', output: finished.output, summary: finished.summary, cost };
    else yield { type: 'result', output: { text: result.text }, summary: result.text.slice(0, 200), cost };
  }
}
```
Se `Promise.race` com o timer for considerado feio pelo revisor, alternativa equivalente: `generate` aceitar um callback `onToolEvent`; manter a versão acima como primeira implementação.

`package.json` deps: `@wizardingcode/shibaox-core`, `@wizardingcode/shibaox-providers`, `@wizardingcode/shibaox-schemas`, `ai`, `zod`. `vitest.config.ts` com aliases para core, schemas, providers (`../providers/src/index.ts`) e `@wizardingcode/shibaox-providers/testing` (`../providers/src/testing/fake-openai.ts`).

- [ ] **Step 3: Correr, commit**

```bash
git add packages/adapter-direct pnpm-lock.yaml
git commit -m "feat(adapter-direct): AI SDK agent loop with workspace-scoped tools"
```

---

### Task 8: CLI — `providers`, `models`, `run --adapter direct` e e2e real opcional

**Files:**
- Create: `apps/cli/src/commands/providers.ts`, `apps/cli/src/commands/models.ts`, `apps/cli/src/wiring.ts`
- Modify: `apps/cli/src/commands/run.ts`, `apps/cli/src/commands/resume.ts`, `apps/cli/src/index.ts`, `apps/cli/src/templates.ts` (models.yaml e gate `qa` com check jev), `apps/cli/package.json`, `README.md`
- Test: `apps/cli/test/providers.test.ts`, `apps/cli/test/run-direct-e2e.test.ts`, `apps/cli/test/real.test.ts`

**Interfaces:**
- Produces: `buildRuntime(opts: { org: Org; registry: ProviderRegistry; jev?: JevClient; adapter?: string; human; log; store }) → { engine: RunEngine; warnings: string[] }` em `wiring.ts`: cria `DirectAdapter` (resolveRef via `resolveModel`), `MockAdapter`, `checkRunners` = default + `jev` (se configurado, com `escalate` = judge) + `judge` (modelo do tier `strong` ou `models.gates.judge`), `decider` = `JevDecider` com fallback `LeadDecider` se Jev configurado, senão `LeadDecider` se há um modelo `strong` configurado, senão `ScriptedDecider('ship')` com aviso. Comandos: `shibaox providers list [--configured]`, `shibaox providers test <id> [--model <m>]`, `shibaox models --org <dir>`, `run --adapter <mock|direct>` (default: `direct` se algum fornecedor do tier `strong` estiver configurado, senão `mock` com aviso).

- [ ] **Step 1: Testes (falham)**

`apps/cli/test/providers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatProviderList, testProvider } from '../src/commands/providers.js';
import { ProviderRegistry, loadCatalog } from '@wizardingcode/shibaox-providers';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';

describe('providers command', () => {
  it('lists providers with configuration status and verify flag', () => {
    const lines = formatProviderList(new ProviderRegistry(loadCatalog(), { OPENROUTER_API_KEY: 'k' }));
    expect(lines.find((l) => l.startsWith('openrouter'))).toMatch(/configured/);
    expect(lines.find((l) => l.startsWith('anthropic '))).toMatch(/missing ANTHROPIC_API_KEY/);
    expect(lines.find((l) => l.startsWith('anthropic-subscription'))).toMatch(/via runtime claude-code/);
    expect(lines.find((l) => l.startsWith('kilocode'))).toMatch(/unverified/);
  });
  it('testProvider makes one real call against the configured base url', async () => {
    const fake = await startFakeOpenAI(() => ({ content: 'pong' }));
    const reg = new ProviderRegistry([{ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: fake.baseURL, auth: { type: 'none' }, models: ['m'], pricing: {}, verify: false }], {});
    const r = await testProvider(reg, 'fake');
    expect(r).toMatchObject({ ok: true, model: 'm' });
    expect(r.text).toBe('pong');
    await fake.close();
  });
  it('testProvider fails fast with the missing env var', async () => {
    const r = await testProvider(new ProviderRegistry(loadCatalog(), {}), 'groq');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('GROQ_API_KEY');
  });
});
```

`apps/cli/test/run-direct-e2e.test.ts` (fake OpenAI + fake Jev, org do `init` com `models.yaml` a apontar para o fake):
```ts
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoApproveHuman } from '@wizardingcode/shibaox-core';
import { startFakeOpenAI } from '@wizardingcode/shibaox-providers/testing';
import { startFakeJev } from '@wizardingcode/shibaox-jev/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffoldOrg } from '../src/commands/init.js';
import { runWorkflow } from '../src/commands/run.js';

const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
let fakes: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const f of fakes) await f.close(); fakes = []; });

describe('shibaox run --adapter direct (fake providers)', () => {
  it('completes hello-feature with a direct model, jev checks and a judge fallback', async () => {
    const llm = await startFakeOpenAI((req, turn) => {
      const text = JSON.stringify(req.messages);
      if (text.includes('Rubric:')) return { content: '{"passed": true, "evidence": "fine"}' };
      if (text.includes('Options: ship, rework')) return { content: '{"choice": "ship", "reasoning": "ok"}' };
      return turn % 2 === 0 ? { toolCalls: [{ name: 'finish', args: { output: { note: 'done' }, summary: 'done' } }] } : { content: 'done' };
    });
    const jev = await startFakeJev((req) => Object.fromEntries(Object.keys(req.questions).map((k) => [k, req.questions[k]?.type === 'choice' ? { type: 'choice', choice: 'ship', confidence: 0.95, probabilities: { ship: 0.95, rework: 0.05 } } : { type: 'noul', noul: 0.9 }])));
    fakes.push(llm, jev);
    const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
    scaffoldOrg(dir);
    writeFileSync(join(dir, 'org/models.yaml'), `providers: {}\ntiers: { strong: fake/m, cheap: fake/m, decision: jev-latest }\nroles: {}\ngates: {}\n`);
    const project = join(dir, 'project');
    cpSync(sample, project, { recursive: true });
    const state = await runWorkflow('hello-feature', {
      org: join(dir, 'org'), project, db: join(dir, 'events.db'), input: 'add /health', adapter: 'direct', human: new AutoApproveHuman(), log: () => {},
      env: { TYPESAFE_API_KEY: 'k', SHIBAOX_JEV_BASE_URL: jev.baseURL },
      extraProviders: [{ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: llm.baseURL, auth: { type: 'none' }, models: ['m'], pricing: { m: { input_per_m: 1, output_per_m: 1 } }, verify: false }],
    });
    expect(state.status).toBe('completed');
    expect(state.nodes.qa?.status).toBe('passed');
    expect(state.lastGateReport?.checks.map((c) => c.type)).toEqual(['code', 'jev']);
    expect(state.spentUsd).toBeGreaterThan(0);
  });
});
```
Para isso `RunOptions` ganha `env?: NodeJS.ProcessEnv` (default `process.env`), `extraProviders?: ProviderEntry[]` (juntos ao catálogo), e o `JevClient` lê `SHIBAOX_JEV_BASE_URL` do `env` quando definido. O template `org/gates/tests.yaml` ganha um segundo check: `- { name: spec, type: jev, question: "The outputs implement the request", threshold: 0.8 }`; o template `models.yaml` passa a `tiers: { strong: anthropic/claude-sonnet-5, cheap: ollama/llama3.2, decision: jev-latest }` com um comentário a explicar `anthropic-subscription/...` para quem usa a subscrição.

`apps/cli/test/real.test.ts` (só corre com chaves):
```ts
import { describe, expect, it } from 'vitest';
import { ProviderRegistry, loadCatalog } from '@wizardingcode/shibaox-providers';
import { testProvider } from '../src/commands/providers.js';

const reg = new ProviderRegistry(loadCatalog());
for (const id of ['openrouter', 'groq', 'anthropic', 'ollama']) {
  describe.skipIf(!reg.isConfigured(id).ok || process.env.SHIBAOX_REAL_TESTS !== '1')(`real: ${id}`, () => {
    it('answers a short prompt', async () => {
      const r = await testProvider(reg, id);
      expect(r.ok, r.error).toBe(true);
    }, 60_000);
  });
}
```

- [ ] **Step 2: Implementar**

`apps/cli/src/commands/providers.ts`:
```ts
import { type ProviderRegistry, generate } from '@wizardingcode/shibaox-providers';

export function formatProviderList(reg: ProviderRegistry, onlyConfigured = false): string[] {
  const rows: string[] = [];
  for (const e of reg.list()) {
    const cfg = reg.isConfigured(e.id);
    if (onlyConfigured && !cfg.ok) continue;
    const status = e.via_runtime ? `via runtime ${e.via_runtime}` : cfg.ok ? 'configured' : `missing ${cfg.missing.join(', ')}`;
    rows.push(`${e.id.padEnd(30)} ${status.padEnd(44)} ${e.verify ? 'unverified URL' : ''}`.trimEnd());
  }
  return rows;
}

export async function testProvider(reg: ProviderRegistry, id: string, model?: string): Promise<{ ok: boolean; model?: string; text?: string; error?: string; ms?: number }> {
  const e = reg.get(id);
  if (e.via_runtime) return { ok: false, error: `provider "${id}" is used through the ${e.via_runtime} runtime; test it with that CLI` };
  const cfg = reg.isConfigured(id);
  if (!cfg.ok) return { ok: false, error: `provider "${id}" is not configured: set ${cfg.missing.join(', ')}` };
  const m = model ?? e.models[0];
  if (!m) return { ok: false, error: `provider "${id}" has no default model; pass --model` };
  const t0 = Date.now();
  try {
    const r = await generate({ model: reg.model(`${id}/${m}`), messages: [{ role: 'user', content: 'Reply with the single word: pong' }], maxSteps: 1 });
    return { ok: true, model: m, text: r.text.trim(), ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, model: m, error: err instanceof Error ? err.message : String(err), ms: Date.now() - t0 };
  }
}
```

`apps/cli/src/commands/models.ts`: para cada papel da org, chamar `resolveModel` e imprimir `role  tier  → direct <ref> | runtime <x> (<model>)  [warnings]`; erros por papel impressos como `!! <mensagem>` sem abortar.

`apps/cli/src/wiring.ts`:
```ts
import { DirectAdapter } from '@wizardingcode/shibaox-adapter-direct';
import { type CheckRunners, type Decider, type EventStore, type HumanHandler, MockAdapter, RunEngine, ScriptedDecider, type TaskJob, defaultCheckRunners, resolveModel } from '@wizardingcode/shibaox-core';
import { JevClient, JevDecider, jevCheckRunner } from '@wizardingcode/shibaox-jev';
import { LeadDecider, LlmClient, type ProviderEntry, ProviderRegistry, judgeCheckRunner, loadCatalog } from '@wizardingcode/shibaox-providers';
import type { Org } from '@wizardingcode/shibaox-schemas';

const mockAdapter = () => new MockAdapter((j) => ({ output: { instruction: j.instruction }, summary: `mock ${j.role.role}: ${j.instruction}`, cost: { usd: 0.001, inputTokens: 10, outputTokens: 10 } }));

export function buildRuntime(o: { org: Org; store: EventStore; human: HumanHandler; log: (l: string) => void; adapter?: string; env?: NodeJS.ProcessEnv; extraProviders?: ProviderEntry[]; orgRoot: string }) {
  const env = o.env ?? process.env;
  const registry = new ProviderRegistry([...loadCatalog(), ...(o.extraProviders ?? [])], env);
  const routerProviders = registry.list().map((e) => ({ id: e.id, via_runtime: e.via_runtime, configured: registry.isConfigured(e.id).ok }));
  const runtimes = ['mock', 'direct'];
  const warnings: string[] = [];
  const llm = new LlmClient(registry);
  const strongRef = o.org.models.gates.judge ?? o.org.models.tiers.strong;
  const strongOk = strongRef ? (() => { try { registry.model(strongRef); return true; } catch { return false; } })() : false;
  const adapter = o.adapter ?? (strongOk ? 'direct' : 'mock');
  if (!o.adapter && adapter === 'mock') warnings.push('no configured model for tier "strong"; using the mock adapter (set models.yaml and provider keys)');
  const resolveRef = (job: TaskJob) => { const r = resolveModel({ role: job.role, models: o.org.models, providers: routerProviders, runtimes, defaultAdapter: 'direct' }); if (r.resolution.kind !== 'direct') throw new Error(`role ${job.role.role} resolved to runtime ${r.resolution.runtime}, not available in phase 1B-1`); for (const w of r.warnings) o.log(w); return r.resolution.ref; };
  const jevKey = env.TYPESAFE_API_KEY;
  const jev = jevKey ? new JevClient({ apiKey: jevKey, baseURL: env.SHIBAOX_JEV_BASE_URL }) : undefined;
  const judge = strongOk && strongRef ? judgeCheckRunner(llm, strongRef) : undefined;
  const checkRunners: CheckRunners = { ...defaultCheckRunners(), ...(judge ? { judge } : {}), ...(jev ? { jev: jevCheckRunner(jev, { escalate: judge }) } : {}) };
  if (!jev) warnings.push('TYPESAFE_API_KEY not set: jev checks will fail; decisions use the LLM lead or the scripted decider');
  const lead: Decider | undefined = strongOk && strongRef ? new LeadDecider(llm, strongRef) : undefined;
  const decider: Decider = jev ? new JevDecider(jev, { threshold: 0.8, fallback: lead }) : (lead ?? new ScriptedDecider({}, 'ship'));
  if (!jev && !lead) warnings.push('no decider model configured: decide nodes always pick "ship"');
  const engine = new RunEngine({ store: o.store, org: o.org, adapters: { mock: mockAdapter(), direct: new DirectAdapter({ registry, resolveRef, orgRoot: o.orgRoot }) }, defaultAdapter: adapter, decider, human: o.human, checkRunners, log: o.log });
  return { engine, warnings, registry, adapter };
}
```
`run.ts` e `resume.ts` passam a usar `buildRuntime` (imprimem `warnings` com prefixo `warn:`). `index.ts` regista `providers list|test` e `models`; `--adapter` usa `.choices(['mock', 'direct'])` sem default (o `buildRuntime` decide). `README.md`: secção "Providers" (catálogo, `providers list/test`, env vars, `models.yaml` com as duas vias Anthropic, Ollama/LM Studio locais, `SHIBAOX_REAL_TESTS=1`).

- [ ] **Step 3: Correr tudo e um run real**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
Run manual (com Ollama a correr localmente e `ollama pull qwen2.5-coder:7b`, ou com `OPENROUTER_API_KEY`):
```bash
node apps/cli/dist/index.js providers list --configured
node apps/cli/dist/index.js providers test ollama --model qwen2.5-coder:7b
node apps/cli/dist/index.js init /tmp/sx-1b && sed -i '' 's#strong: .*#strong: ollama/qwen2.5-coder:7b#; s#cheap: .*#cheap: ollama/qwen2.5-coder:7b#' /tmp/sx-1b/org/models.yaml
node apps/cli/dist/index.js models --org /tmp/sx-1b/org
node apps/cli/dist/index.js run hello-feature --org /tmp/sx-1b/org --project examples/sample-repo --input "add a subtract function with a test" --adapter direct
```
Expected: `models` mostra `direct ollama/...` para os três papéis; o run termina `completed` (ou `waiting_human` sem TTY) com `spentUsd` 0 para Ollama (sem pricing) e o gate `tests` verde; sem `TYPESAFE_API_KEY` o check `jev` reprova e o run acaba `failed` após os retries: isso é o comportamento esperado e o aviso impresso explica-o. Registar no report o resultado real obtido nesta máquina.

- [ ] **Step 4: Commit**

```bash
git add apps/cli README.md pnpm-lock.yaml
git commit -m "feat(cli): providers list/test, models, direct adapter wiring with jev and judge"
```

---

## Self-review

**Cobertura da spec 1B (secções 1, 2, 3, 4, 7):** catálogo + registry + `LlmClient` + CLI `providers` → Tasks 3, 4, 8; `DirectAdapter` com tools restritas → Task 7; Jev (client, fan-out, decider, check runner, truncagem) → Task 5; router `resolveModel`, `judgeCheckRunner`, `LeadDecider`, custos de checks → Tasks 2 e 6; endurecimento (cancelamento, snapshot, stall, `resume --budget`) → Tasks 1 e 2. Fica para 1B-2: adaptador Claude Code, worktree, vault, graphify, `graph_query`, autorouting.

**Review Focus → testes:** (1) chave em falta → `registry.test.ts` "throws a clear error", `providers.test.ts` "fails fast"; (2) escape do workspace → `safe-path.test.ts` e `adapter.test.ts` "refuses paths outside"; (3) modelo sem `finish` → `adapter.test.ts` "finishes with the text"; (4) confiança baixa nunca aprova → `check-runner.test.ts` "never passes on low confidence"; (5) cancelamento → `engine.test.ts` "cancel() aborts" e `adapter.test.ts` "aborts when the signal fires".

**Consistência de nomes:** `ProviderRegistry.model/isConfigured/estimateCost/parseRef`, `generate`/`LlmClient.generate`, `startFakeOpenAI`/`startFakeJev`, `JevClient.fanOut`, `gateByConfidence`, `JevDecider`, `jevCheckRunner`, `judgeCheckRunner`, `LeadDecider`, `resolveModel`, `DirectAdapter`, `safePath`, `buildTools`, `buildRuntime`, `formatProviderList`, `testProvider` são usados com os mesmos nomes em todas as tarefas. `RuntimeAdapter.cancel` deixa de existir a partir da Task 1.

**Incerteza declarada:** as assinaturas exatas do AI SDK 7 (`generateText` com `output` + `tools`, forma de `usage`) e dos `create*` de cada pacote de fornecedor não foram executadas nesta sessão; cada tarefa indica ao implementador como adaptar e reportar. O `catalog.yaml` marca com `verify: true` as URLs não confirmadas.
