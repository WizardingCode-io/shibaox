# shibaox Fase 1B-2 (adaptador Claude Code, worktrees, memória, autorouting) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correr `hello-feature` com o Claude Code real (subscrição ou API key) num git worktree por run, com o grafo graphify disponível ao agente por MCP, uma nota do run escrita no vault Obsidian, e o autorouting v0 a escolher que capacidades entram na invocação. Fechar as dívidas de 1A/1B-1 que tocam estas interfaces.

**Architecture:** Novo pacote `@wizardingcode/shibaox-adapter-claude-code` sobre `@anthropic-ai/claude-agent-sdk` (`query()` com `systemPrompt` preset+append, `cwd` no worktree, `allowedTools` derivados de `role.tools`, `canUseTool` que consulta o `HumanHandler` para `approval_required`, `maxBudgetUsd`, `mcpServers`, `settingSources: []`, `abortController` ligado ao signal). Novo pacote `@wizardingcode/shibaox-workspace` (worktree por run). Novo pacote `@wizardingcode/shibaox-memory` (vault writer + runner do graphify + config MCP). `selectCapabilities` (autorouting v0) em core. CLI: `--adapter claude-code`, `--workspace`, `graph`, `worktree`, nota no vault no fim do run. Testes do adaptador usam uma `query` fake injetada; um teste real opcional corre com `SHIBAOX_REAL_TESTS=1` e o CLI `claude` autenticado.

**Tech Stack:** @anthropic-ai/claude-agent-sdk@^0.3.283 (peers: zod ^4, @anthropic-ai/sdk >=0.93, @modelcontextprotocol/sdk ^1.29), graphify (`uv tool install graphifyy`, CLI 0.9.x), git worktrees, yaml, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-25-shibaox-1b-design.md` (secções 5, 6, 2 texto-só) + backlog em `docs/superpowers/plans/2026-09-25-fase-1b1-providers.md` self-review e ledger 1B-1.

## Global Constraints

- ESM, `module: NodeNext`, imports relativos com `.js`, `strict: true`, sem `any` fora de testes.
- Eventos imutáveis; estado sempre por `replay`. O runtime nunca conhece o workflow.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` verdes (lint: 0 erros) antes de cada commit; commits `type(scope): message` com trailer `Co-Authored-By` do modelo que escreveu.
- Nenhum teste faz chamadas reais por defeito. Testes reais: `describe.skipIf(process.env.SHIBAOX_REAL_TESTS !== '1' || !<binário>)`.
- Factos do SDK usados em todo o plano (verificados em `sdk.d.ts` 0.3.283): `query({ prompt, options })` é `AsyncGenerator<SDKMessage>`; `Options.systemPrompt: string | { type: 'preset', preset: 'claude_code', append?: string }`; `cwd`, `model`, `allowedTools: string[]`, `disallowedTools: string[]`, `permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'`, `canUseTool: (toolName, input, { signal, suggestions? }) => Promise<{ behavior: 'allow', updatedInput?, updatedPermissions? } | { behavior: 'deny', message, interrupt? }>`, `mcpServers: Record<string, { type?: 'stdio', command, args?, env? } | McpSdkServerConfigWithInstance>`, `maxTurns`, `maxBudgetUsd`, `settingSources: ('user'|'project'|'local')[]`, `outputFormat: { type: 'json_schema', schema }`, `abortController`, `env`. Mensagens: `{ type: 'system', subtype: 'init', tools, mcp_servers: { name, status }[], model, cwd }`, `{ type: 'assistant', message: { content: ({ type: 'text', text } | { type: 'tool_use', id, name, input })[] } }`, `{ type: 'user', message: { content: ({ type: 'tool_result', tool_use_id, content })[] } }`, `{ type: 'result', subtype: 'success', result: string, total_cost_usd, usage: { input_tokens, output_tokens, ... }, structured_output?, num_turns, permission_denials }` ou `{ type: 'result', subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries', total_cost_usd, usage, is_error }`. Tools MCP chamam-se `mcp__<server>__<tool>`; `createSdkMcpServer({ name, tools: [tool(name, description, zodShape, handler)] })`.
- graphify (CLI 0.9.x): `graphify extract <path> --code-only [--out DIR]` (AST local, sem chave), `graphify update <path>`, `graphify query "<q>" [--graph <json>] [--budget N]`, `graphify merge-graphs g1 g2 --out <path>`, servidor MCP `"$PY" -m graphify.serve <graph.json>` (stdio) onde `$PY = uv tool run --from graphifyy python -c "import sys; print(sys.executable)"`. Tools MCP do graphify: `query_graph`, `get_node`, `get_neighbors`, `shortest_path`.
- Ollama/LM Studio continuam a entrar pelo runtime direto; o Claude Code é o único runtime externo nesta fase.

## Review Focus

1. O adaptador Claude Code nunca pode permitir uma ação de `approval_required` (push, deploy) sem a resposta do `HumanHandler`; sem TTY a aprovação é adiada e a tarefa termina com erro `approval pending for <categoria>`, pelo que a run fica `failed` (decisão aceite na revisão; a fila persistente de aprovações vem com o control plane), nunca avança sem aprovação. Teste na Task 2.
2. Um run em worktree nunca escreve no checkout principal do projeto; se o projeto não é um repo git, a CLI recusa `--workspace worktree` com mensagem clara. Teste na Task 1.
3. O vault writer nunca escreve fora da pasta do vault nem sobrescreve notas humanas: notas do sistema vivem em `90-system/runs/` e `10-projects/<proj>/runs/`; colisão de nome acrescenta sufixo. Teste na Task 3.
4. Falha do graphify (não instalado, sem `uv`, extração falhou) degrada para "sem grafo" com aviso, nunca falha o run. Teste na Task 3.
5. O autorouting nunca injeta uma capacidade com confiança abaixo do limiar nem uma que não esteja no catálogo da organização. Teste na Task 5.

---

### Task 1: `@wizardingcode/shibaox-workspace` — worktree por run

**Files:**
- Create: `packages/workspace/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/worktree.ts`
- Test: `packages/workspace/test/worktree.test.ts`

**Interfaces:**
- Consumes: `runArgv` de `@wizardingcode/shibaox-core`.
- Produces:
```ts
type WorkspaceMode = 'inplace' | 'worktree';
interface RunWorkspace { path: string; mode: WorkspaceMode; branch?: string }
isGitRepo(dir: string): Promise<boolean>
createRunWorkspace(args: { project: string; runId: string; mode: WorkspaceMode }): Promise<RunWorkspace>
  // worktree: `git worktree add <project>/.shibaox/worktrees/<runId> -b shibaox/<runId>` a partir do HEAD; adiciona `.shibaox/` ao `.git/info/exclude` do projeto se não estiver
  // inplace: devolve { path: project, mode: 'inplace' }
  // erro `project is not a git repository; use --workspace inplace` quando mode=worktree e !isGitRepo
listRunWorkspaces(project: string): Promise<{ runId: string; path: string; branch: string }[]>   // via `git worktree list --porcelain`
removeRunWorkspace(args: { project: string; runId: string; deleteBranch?: boolean }): Promise<void>  // `git worktree remove --force <path>` + opcional `git branch -D shibaox/<runId>`
diffRunWorkspace(path: string): Promise<string>   // `git diff HEAD` no worktree (untracked incluídos via `git add -N`? não: usar `git diff` + `git status --porcelain` concatenados), truncado a 200k chars
```

- [ ] **Step 1: Testes (falham)**

`packages/workspace/test/worktree.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRunWorkspace, diffRunWorkspace, isGitRepo, listRunWorkspaces, removeRunWorkspace } from '../src/index.js';

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

describe('run workspaces', () => {
  it('detects git repos', async () => {
    expect(await isGitRepo(repo())).toBe(true);
    expect(await isGitRepo(mkdtempSync(join(tmpdir(), 'plain-')))).toBe(false);
  });
  it('creates a worktree on its own branch and never touches the main checkout', async () => {
    const project = repo();
    const ws = await createRunWorkspace({ project, runId: 'r1', mode: 'worktree' });
    expect(ws.mode).toBe('worktree');
    expect(ws.branch).toBe('shibaox/r1');
    expect(ws.path).toBe(join(project, '.shibaox', 'worktrees', 'r1'));
    writeFileSync(join(ws.path, 'b.txt'), 'b\n');
    expect(existsSync(join(project, 'b.txt'))).toBe(false);
    expect(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8')).toContain('.shibaox/');
    const diff = await diffRunWorkspace(ws.path);
    expect(diff).toContain('b.txt');
    const list = await listRunWorkspaces(project);
    expect(list.map((w) => w.runId)).toEqual(['r1']);
    await removeRunWorkspace({ project, runId: 'r1', deleteBranch: true });
    expect(existsSync(ws.path)).toBe(false);
    expect(await listRunWorkspaces(project)).toEqual([]);
  });
  it('inplace returns the project path', async () => {
    const project = repo();
    expect(await createRunWorkspace({ project, runId: 'r2', mode: 'inplace' })).toEqual({ path: project, mode: 'inplace' });
  });
  it('refuses worktree mode outside a git repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'plain-'));
    await expect(createRunWorkspace({ project: plain, runId: 'r3', mode: 'worktree' })).rejects.toThrow(/not a git repository; use --workspace inplace/);
  });
});
```

- [ ] **Step 2: Implementar**

`packages/workspace/src/worktree.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runArgv } from '@wizardingcode/shibaox-core';

export type WorkspaceMode = 'inplace' | 'worktree';
export interface RunWorkspace { path: string; mode: WorkspaceMode; branch?: string }

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runArgv({ argv: ['git', ...args], cwd, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  const r = await runArgv({ argv: ['git', 'rev-parse', '--is-inside-work-tree'], cwd: dir, timeoutMs: 10_000 });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

function ensureExcluded(project: string): void {
  const exclude = join(project, '.git', 'info', 'exclude');
  if (!existsSync(join(project, '.git', 'info'))) mkdirSync(join(project, '.git', 'info'), { recursive: true });
  const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!current.split('\n').includes('.shibaox/')) appendFileSync(exclude, `${current.endsWith('\n') || current === '' ? '' : '\n'}.shibaox/\n`);
}

export async function createRunWorkspace(args: { project: string; runId: string; mode: WorkspaceMode }): Promise<RunWorkspace> {
  if (args.mode === 'inplace') return { path: args.project, mode: 'inplace' };
  if (!(await isGitRepo(args.project))) throw new Error(`project "${args.project}" is not a git repository; use --workspace inplace`);
  ensureExcluded(args.project);
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  const branch = `shibaox/${args.runId}`;
  mkdirSync(join(args.project, '.shibaox', 'worktrees'), { recursive: true });
  await git(args.project, ['worktree', 'add', '-q', path, '-b', branch]);
  return { path, mode: 'worktree', branch };
}

export async function listRunWorkspaces(project: string): Promise<{ runId: string; path: string; branch: string }[]> {
  const out = await git(project, ['worktree', 'list', '--porcelain']);
  const items: { runId: string; path: string; branch: string }[] = [];
  let current: { path?: string; branch?: string } = {};
  for (const line of `${out}\n`.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) };
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === '' && current.path) {
      if (current.branch?.startsWith('shibaox/')) items.push({ runId: current.branch.slice('shibaox/'.length), path: current.path, branch: current.branch });
      current = {};
    }
  }
  return items;
}

export async function removeRunWorkspace(args: { project: string; runId: string; deleteBranch?: boolean }): Promise<void> {
  const path = join(args.project, '.shibaox', 'worktrees', args.runId);
  await git(args.project, ['worktree', 'remove', '--force', path]);
  if (args.deleteBranch) await git(args.project, ['branch', '-D', `shibaox/${args.runId}`]);
}

export async function diffRunWorkspace(path: string, maxChars = 200_000): Promise<string> {
  const diff = (await runArgv({ argv: ['git', 'diff', 'HEAD'], cwd: path, timeoutMs: 60_000 })).stdout;
  const status = (await runArgv({ argv: ['git', 'status', '--porcelain'], cwd: path, timeoutMs: 60_000 })).stdout;
  const text = `${diff}\n## status\n${status}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(truncated)` : text;
}
```
`src/index.ts`: `export * from './worktree.js';`. Package deps: `@wizardingcode/shibaox-core`; devDeps `@types/node`.

- [ ] **Step 3: Correr, commit**

```bash
git add packages/workspace pnpm-lock.yaml
git commit -m "feat(workspace): git worktree per run with list/remove/diff"
```

---

### Task 2: `@wizardingcode/shibaox-adapter-claude-code`

**Files:**
- Create: `packages/adapter-claude-code/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/adapter.ts`, `src/tools-map.ts`, `src/permissions.ts`, `src/testing/fake-query.ts`
- Modify: `packages/core/src/executors/types.ts` (`TaskJob` ganha `budgetRemainingUsd?: number`, `outputSchema?: Record<string, unknown>`, `mcpServers?: Record<string, unknown>`), `packages/core/src/run/engine.ts` (preenche `budgetRemainingUsd` = `budgetUsd - spentUsd` quando há orçamento)
- Test: `packages/adapter-claude-code/test/tools-map.test.ts`, `test/permissions.test.ts`, `test/adapter.test.ts`, `test/real.test.ts`

**Interfaces:**
- Consumes: `RuntimeAdapter`, `TaskJob`, `ExecutionContext`, `RuntimeEvent`, `HumanHandler`, `HumanRequest` (core); `Role` (schemas); `query`, `Options`, `SDKMessage` (`@anthropic-ai/claude-agent-sdk`).
- Produces:
```ts
interface ClaudeCodeAdapterOptions { human: HumanHandler; orgRoot?: string; model?: (job: TaskJob) => string | undefined; mcpServers?: (job: TaskJob) => Record<string, McpServerConfig>; maxTurns?: number /* default 60 */; queryFn?: typeof query /* injectable for tests */; env?: Record<string, string> }
class ClaudeCodeAdapter implements RuntimeAdapter { readonly id = 'claude-code'; capabilities(): ['write-code','run-tests','shell'] }
mapRoleTools(role: Role): { allowedTools: string[]; disallowedTools: string[] }
  // 'read' → ['Read','Glob','Grep','WebFetch'?] no: 'read' → ['Read','Glob','Grep']; 'write' → ['Edit','Write','MultiEdit'? use 'Edit','Write']; 'git' → ['Bash(git *)']; 'node' → ['Bash(node *)']; 'pnpm' → ['Bash(pnpm *)']; 'npm' → ['Bash(npm *)']; other X → [`Bash(${X} *)`]
  // sempre disallowed: ['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git push)', 'WebFetch', 'WebSearch'] — push/deploy só via canUseTool (ver abaixo); se role.permissions.approval_required inclui 'push', remover 'Bash(git push *)' de disallowed para que caia no canUseTool
buildCanUseTool(args: { role: Role; human: HumanHandler; runId; nodeId; log }): CanUseTool
  // classifica o pedido: push (`git push`), deploy (comandos que começam por `deploy`/`vercel`/`fly`/`kubectl apply`), other
  // se a categoria está em role.permissions.approval_required → human.ask({ runId, nodeId, action: `approve-${category}`, prompt: `<tool> ${command}` }); deferred → deny com message 'approval pending: run is waiting for a human' e `interrupt: true`; approved → allow; rejected → deny
  // qualquer outro pedido que chegue ao callback (não coberto pelo allowlist) → deny com message `tool "<name>" is not allowed for role <role>` (nunca allow implícito)
```
Comportamento de `run(job, ctx)`:
- `prompt` = instrução + input + previousOutputs + lastGateReport (JSON truncados como no DirectAdapter).
- `options`: `systemPrompt: { type: 'preset', preset: 'claude_code', append: <prompt do papel> }`, `cwd: job.workspace`, `model: opts.model?.(job)`, `allowedTools/disallowedTools` de `mapRoleTools`, `permissionMode: 'default'`, `canUseTool`, `maxTurns`, `maxBudgetUsd: job.budgetRemainingUsd`, `mcpServers: opts.mcpServers?.(job)` + `allowedTools` recebe `mcp__<name>__*` por servidor, `settingSources: []`, `outputFormat: job.outputSchema ? { type: 'json_schema', schema: job.outputSchema } : undefined`, `abortController` ligado a `ctx.signal`, `env: opts.env`.
- Mapeamento de mensagens: `system/init` → `text` com `claude-code ready: model=<m> tools=<n> mcp=<names:status>` e, se algum MCP está `failed`, `ctx.log` de aviso; `assistant` blocos `text` → `text`; `tool_use` → `tool_use { name, input }`; `user` blocos `tool_result` → `tool_result { name: <lookup por tool_use_id>, output: content }`; `Edit/Write/MultiEdit` tool_use → também `file_changed { path: input.file_path }`; `result success` → `result { output: structured_output ?? { text: result }, summary: result.slice(0,200), cost: { usd: total_cost_usd, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }`; `result error_*` → `error { message: <subtype> + permission_denials resumo, cost }`; exceção do generator → `error { message: describeError(e) }`.
- Aborto: `ctx.signal` → `abortController.abort()`; o generator termina com `error`.

- [ ] **Step 1: Pacote e fake**

`package.json` deps: `@anthropic-ai/claude-agent-sdk ^0.3.283`, `@wizardingcode/shibaox-core`, `@wizardingcode/shibaox-providers` (para `describeError`), `@wizardingcode/shibaox-schemas`, `zod`; peers do SDK instalam via `auto-install-peers`. `vitest.config.ts` com aliases core/providers/schemas.

`src/testing/fake-query.ts`:
```ts
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface FakeQueryCall { prompt: string; options: Options }
export type FakeScript = (call: FakeQueryCall) => AsyncIterable<SDKMessage> | SDKMessage[];

export function fakeQuery(script: FakeScript) {
  const calls: FakeQueryCall[] = [];
  const fn = ({ prompt, options }: { prompt: string; options?: Options }) => {
    const call = { prompt: String(prompt), options: options ?? {} };
    calls.push(call);
    const out = script(call);
    async function* gen() { for await (const m of Array.isArray(out) ? out : out) yield m; }
    return gen();
  };
  return Object.assign(fn, { calls });
}

export const msg = {
  init: (extra: Partial<{ model: string; tools: string[]; mcp_servers: { name: string; status: string }[] }> = {}) => ({ type: 'system', subtype: 'init', model: 'claude-sonnet-5', tools: ['Read', 'Edit'], mcp_servers: [], cwd: '/w', ...extra }) as unknown as SDKMessage,
  text: (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as SDKMessage,
  toolUse: (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } }) as unknown as SDKMessage,
  toolResult: (id: string, content: unknown) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }) as unknown as SDKMessage,
  success: (result: string, extra: Partial<{ total_cost_usd: number; structured_output: unknown; usage: { input_tokens: number; output_tokens: number } }> = {}) => ({ type: 'result', subtype: 'success', result, total_cost_usd: 0.12, usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 2, permission_denials: [], is_error: false, ...extra }) as unknown as SDKMessage,
  error: (subtype: string, cost = 0.05) => ({ type: 'result', subtype, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 1 }, is_error: true, num_turns: 1, permission_denials: [] }) as unknown as SDKMessage,
};
```
O `queryFn` do adaptador é tipado como `(args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>`; o `query` real satisfaz esse tipo (é um `Query extends AsyncGenerator`).

- [ ] **Step 2: Testes (falham)**

`test/tools-map.test.ts`:
```ts
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { mapRoleTools } from '../src/index.js';

describe('mapRoleTools', () => {
  it('maps role.tools to Claude Code allow rules and always denies dangerous commands', () => {
    const r = mapRoleTools(RoleSchema.parse({ role: 'backend', tools: ['read', 'write', 'git', 'node', 'pnpm', 'jq'] }));
    expect(r.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git *)', 'Bash(node *)', 'Bash(pnpm *)', 'Bash(jq *)']);
    expect(r.disallowedTools).toEqual(['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git push)', 'WebFetch', 'WebSearch']);
  });
  it('lets push reach the approval callback when the role requires approval for it', () => {
    const r = mapRoleTools(RoleSchema.parse({ role: 'backend', tools: ['git'], permissions: { approval_required: ['push'] } }));
    expect(r.disallowedTools).not.toContain('Bash(git push *)');
    expect(r.allowedTools).not.toContain('Bash(git push *)');
  });
  it('an empty tools list allows only nothing beyond reading', () => {
    expect(mapRoleTools(RoleSchema.parse({ role: 'analyst' })).allowedTools).toEqual([]);
  });
});
```

`test/permissions.test.ts`:
```ts
import { AutoApproveHuman, DeferHuman, type HumanRequest } from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { buildCanUseTool, classifyToolRequest } from '../src/index.js';

const role = RoleSchema.parse({ role: 'backend', tools: ['git'], permissions: { approval_required: ['push'] } });
const base = { role, runId: 'r', nodeId: 'implement', log: () => {} };
const opts = { signal: new AbortController().signal };

describe('classifyToolRequest', () => {
  it('recognises push and deploy commands', () => {
    expect(classifyToolRequest('Bash', { command: 'git push origin main' })).toBe('push');
    expect(classifyToolRequest('Bash', { command: 'vercel deploy --prod' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'kubectl apply -f x.yaml' })).toBe('deploy');
    expect(classifyToolRequest('Bash', { command: 'ls' })).toBe('other');
    expect(classifyToolRequest('Edit', { file_path: 'a' })).toBe('other');
  });
});

describe('buildCanUseTool', () => {
  it('asks the human for approval_required categories and allows on yes', async () => {
    const asked: HumanRequest[] = [];
    const human = { ask: async (req: HumanRequest) => { asked.push(req); return { approved: true }; } };
    const can = buildCanUseTool({ ...base, human });
    const r = await can('Bash', { command: 'git push origin main' }, opts);
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' } });
    expect(asked[0]).toMatchObject({ action: 'approve-push', nodeId: 'implement' });
  });
  it('denies with interrupt when the human defers', async () => {
    const can = buildCanUseTool({ ...base, human: new DeferHuman() });
    const r = await can('Bash', { command: 'git push' }, opts);
    expect(r).toMatchObject({ behavior: 'deny', interrupt: true });
    expect((r as { message: string }).message).toContain('waiting for a human');
  });
  it('denies anything else that reaches the callback, even with an auto-approving human', async () => {
    const can = buildCanUseTool({ ...base, human: new AutoApproveHuman() });
    const r = await can('Bash', { command: 'curl http://x' }, opts);
    expect(r).toMatchObject({ behavior: 'deny' });
    expect((r as { message: string }).message).toContain('not allowed for role backend');
  });
  it('denies push when the role does not list it in approval_required', async () => {
    const can = buildCanUseTool({ ...base, role: RoleSchema.parse({ role: 'analyst' }), human: new AutoApproveHuman() });
    expect(await can('Bash', { command: 'git push' }, opts)).toMatchObject({ behavior: 'deny' });
  });
});
```

`test/adapter.test.ts`:
```ts
import { AutoApproveHuman, type RuntimeEvent, type TaskJob, collectRun } from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';
import { fakeQuery, msg } from '../src/testing/fake-query.js';

const job = (extra: Partial<TaskJob> = {}): TaskJob => ({ runId: 'r', nodeId: 'implement', role: RoleSchema.parse({ role: 'backend', tools: ['read', 'write', 'git'], system_prompt: undefined, description: 'Backend dev' }), instruction: 'add /health', input: { spec: 'x' }, workspace: '/tmp/ws', context: { previousOutputs: {} }, budgetRemainingUsd: 2.5, ...extra });
const ctx = () => ({ signal: new AbortController().signal, log: () => {} });

describe('ClaudeCodeAdapter', () => {
  it('passes role, workspace, budget and tool rules to query and maps messages to events', async () => {
    const q = fakeQuery(() => [msg.init({ mcp_servers: [{ name: 'graphify', status: 'connected' }] }), msg.text('working'), msg.toolUse('t1', 'Edit', { file_path: 'src/a.ts', old_string: '', new_string: 'x' }), msg.toolResult('t1', 'ok'), msg.success('done', { structured_output: { files: ['src/a.ts'] } })]);
    const adapter = new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q, mcpServers: () => ({ graphify: { type: 'stdio', command: 'python', args: ['-m', 'graphify.serve'] } }) });
    const events: RuntimeEvent[] = [];
    for await (const e of adapter.run(job(), ctx())) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['started', 'text', 'text', 'tool_use', 'file_changed', 'tool_result', 'result']);
    const result = events.at(-1);
    expect(result?.type === 'result' && result.output).toEqual({ files: ['src/a.ts'] });
    expect(result?.type === 'result' && result.cost).toEqual({ usd: 0.12, inputTokens: 100, outputTokens: 50 });
    const o = q.calls[0]!.options;
    expect(o.cwd).toBe('/tmp/ws');
    expect(o.maxBudgetUsd).toBe(2.5);
    expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('default');
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Edit', 'Bash(git *)', 'mcp__graphify__*']));
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash(git push *)']));
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: expect.stringContaining('Backend dev') });
    expect(q.calls[0]!.prompt).toContain('add /health');
  });
  it('turns an error result into an error event with cost', async () => {
    const q = fakeQuery(() => [msg.init(), msg.error('error_max_turns', 0.3)]);
    const adapter = new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q });
    await expect(collectRun(adapter, job(), ctx())).rejects.toMatchObject({ message: expect.stringContaining('error_max_turns'), cost: { usd: 0.3 } });
  });
  it('uses the text result when there is no structured output', async () => {
    const q = fakeQuery(() => [msg.init(), msg.success('All good.')]);
    const r = await collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }), job(), ctx());
    expect(r.output).toEqual({ text: 'All good.' });
  });
  it('aborts the query when the signal fires', async () => {
    const q = fakeQuery(({ options }) => (async function* () { yield msg.init(); await new Promise((r, rej) => { options.abortController?.signal.addEventListener('abort', () => rej(new Error('aborted'))); setTimeout(r, 2000); }); yield msg.success('late'); })());
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }), job(), { signal: ac.signal, log: () => {} })).rejects.toThrow(/abort/);
  });
  it('warns when an MCP server failed to connect', async () => {
    const logs: string[] = [];
    const q = fakeQuery(() => [msg.init({ mcp_servers: [{ name: 'graphify', status: 'failed' }] }), msg.success('x')]);
    await collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), queryFn: q }), job(), { signal: new AbortController().signal, log: (l) => logs.push(l) });
    expect(logs.join('\n')).toContain('graphify');
    expect(logs.join('\n')).toContain('failed');
  });
});
```

`test/real.test.ts` (opt-in):
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutoApproveHuman, type TaskJob, collectRun } from '@wizardingcode/shibaox-core';
import { RoleSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src/index.js';

const hasClaude = (() => { try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(process.env.SHIBAOX_REAL_TESTS !== '1' || !hasClaude)('real claude-code', () => {
  it('creates a file in a temp workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'cc-'));
    const job: TaskJob = { runId: 'r', nodeId: 'n', role: RoleSchema.parse({ role: 'backend', tools: ['read', 'write'] }), instruction: 'Create hello.txt containing exactly "hi". Then stop.', input: {}, workspace: ws, context: { previousOutputs: {} }, budgetRemainingUsd: 0.5 };
    const r = await collectRun(new ClaudeCodeAdapter({ human: new AutoApproveHuman(), maxTurns: 6 }), job, { signal: new AbortController().signal, log: console.log });
    expect(r.cost?.usd).toBeGreaterThan(0);
  }, 180_000);
});
```

- [ ] **Step 3: Implementar**

`src/tools-map.ts`:
```ts
import type { Role } from '@wizardingcode/shibaox-schemas';

const MAP: Record<string, string[]> = { read: ['Read', 'Glob', 'Grep'], write: ['Edit', 'Write'] };
export const ALWAYS_DENY = ['Bash(rm -rf *)', 'Bash(git push *)', 'Bash(git push)', 'WebFetch', 'WebSearch'];

export function mapRoleTools(role: Role): { allowedTools: string[]; disallowedTools: string[] } {
  const allowedTools = role.tools.flatMap((t) => MAP[t] ?? [`Bash(${t} *)`]);
  const needsPushApproval = role.permissions.approval_required.includes('push');
  const disallowedTools = ALWAYS_DENY.filter((d) => !(needsPushApproval && d.startsWith('Bash(git push')));
  return { allowedTools, disallowedTools };
}
```

`src/permissions.ts`:
```ts
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { HumanHandler } from '@wizardingcode/shibaox-core';
import type { Role } from '@wizardingcode/shibaox-schemas';

export type ToolCategory = 'push' | 'deploy' | 'other';
const DEPLOY = [/^(vercel|fly|flyctl|netlify|heroku|railway|wrangler)\b.*\b(deploy|publish)\b/, /^deploy\b/, /^kubectl\s+(apply|rollout|delete)\b/, /^terraform\s+apply\b/, /^helm\s+(install|upgrade)\b/];

export function classifyToolRequest(toolName: string, input: Record<string, unknown>): ToolCategory {
  if (toolName !== 'Bash') return 'other';
  const command = String(input.command ?? '').trim();
  if (/^git\s+push\b/.test(command)) return 'push';
  if (DEPLOY.some((re) => re.test(command))) return 'deploy';
  return 'other';
}

export function buildCanUseTool(args: { role: Role; human: HumanHandler; runId: string; nodeId: string; log: (l: string) => void }): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    const category = classifyToolRequest(toolName, input);
    if (category !== 'other' && args.role.permissions.approval_required.includes(category)) {
      const prompt = `${toolName}: ${String(input.command ?? JSON.stringify(input))}`;
      const answer = await args.human.ask({ runId: args.runId, nodeId: args.nodeId, action: `approve-${category}`, prompt });
      if ('deferred' in answer) return { behavior: 'deny', message: 'approval pending: run is waiting for a human', interrupt: true };
      if (answer.approved) return { behavior: 'allow', updatedInput: input };
      return { behavior: 'deny', message: `human rejected ${category}${answer.note ? `: ${answer.note}` : ''}` };
    }
    args.log(`[claude-code] denied ${toolName} ${JSON.stringify(input).slice(0, 200)}`);
    return { behavior: 'deny', message: `tool "${toolName}" is not allowed for role ${args.role.role}` };
  };
}
```
Nota: o `HumanRequested`/`HumanResponded` do run continuam a ser eventos do motor só para nós `human`; aqui a aprovação é síncrona dentro da tarefa. Quando o handler devolve `deferred`, o adaptador termina a tarefa com `error` "approval pending" e o run fica `failed`? Não: para Review Focus 1, o adaptador emite `error` com mensagem `approval pending for <category>` e a CLI documenta que, sem TTY, tarefas que precisam de aprovação falham; a aprovação humana interativa é o caminho suportado nesta fase (a fila persistente de aprovações vem com o control plane).

`src/adapter.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Options, type SDKMessage, query } from '@anthropic-ai/claude-agent-sdk';
import type { Capability, ExecutionContext, HumanHandler, RuntimeAdapter, RuntimeEvent, TaskJob } from '@wizardingcode/shibaox-core';
import { describeError } from '@wizardingcode/shibaox-providers';
import { buildCanUseTool } from './permissions.js';
import { mapRoleTools } from './tools-map.js';

type QueryFn = (args: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
export interface ClaudeCodeAdapterOptions { human: HumanHandler; orgRoot?: string; model?: (job: TaskJob) => string | undefined; mcpServers?: (job: TaskJob) => NonNullable<Options['mcpServers']>; maxTurns?: number; queryFn?: QueryFn; env?: Record<string, string> }

const RULES = 'You are running as an autonomous worker inside shibaox. Work only inside the current working directory. Do not push, deploy or publish unless the tool call is explicitly approved. When done, summarise what you changed.';

export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code';
  private readonly queryFn: QueryFn;
  constructor(private readonly opts: ClaudeCodeAdapterOptions) { this.queryFn = opts.queryFn ?? (query as unknown as QueryFn); }
  capabilities(): Capability[] { return ['write-code', 'run-tests', 'shell']; }

  private rolePrompt(job: TaskJob): string {
    let prompt = job.role.description ?? `You are the ${job.role.role}.`;
    if (job.role.system_prompt && this.opts.orgRoot) { const p = join(this.opts.orgRoot, job.role.system_prompt); if (existsSync(p)) prompt = readFileSync(p, 'utf8'); }
    return `${prompt}\n\n${RULES}`;
  }

  async *run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent> {
    yield { type: 'started' };
    const abort = new AbortController();
    const onAbort = () => abort.abort(new Error('aborted'));
    if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
    const { allowedTools, disallowedTools } = mapRoleTools(job.role);
    const mcpServers = this.opts.mcpServers?.(job) ?? {};
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.rolePrompt(job) },
      cwd: job.workspace,
      model: this.opts.model?.(job),
      allowedTools: [...allowedTools, ...Object.keys(mcpServers).map((n) => `mcp__${n}__*`)],
      disallowedTools,
      permissionMode: 'default',
      canUseTool: buildCanUseTool({ role: job.role, human: this.opts.human, runId: job.runId, nodeId: job.nodeId, log: ctx.log }),
      maxTurns: this.opts.maxTurns ?? 60,
      maxBudgetUsd: job.budgetRemainingUsd,
      mcpServers,
      settingSources: [],
      outputFormat: job.outputSchema ? { type: 'json_schema', schema: job.outputSchema } : undefined,
      abortController: abort,
      env: this.opts.env,
    };
    const prompt = `Task: ${job.instruction}\n\nInput: ${JSON.stringify(job.input)}\n\nPrevious outputs: ${JSON.stringify(job.context.previousOutputs).slice(0, 60_000)}\n\nLast gate report: ${JSON.stringify(job.context.lastGateReport ?? null).slice(0, 20_000)}`;
    const toolNames = new Map<string, string>();
    try {
      for await (const m of this.queryFn({ prompt, options })) {
        if (m.type === 'system' && m.subtype === 'init') {
          const mcp = m.mcp_servers.map((s) => `${s.name}:${s.status}`).join(',');
          yield { type: 'text', text: `claude-code ready: model=${m.model} tools=${m.tools.length} mcp=${mcp || 'none'}` };
          for (const s of m.mcp_servers) if (s.status === 'failed' || s.status === 'needs-auth') ctx.log(`[claude-code] MCP server ${s.name} ${s.status}`);
        } else if (m.type === 'assistant') {
          for (const block of m.message.content) {
            if (block.type === 'text') yield { type: 'text', text: block.text };
            else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              yield { type: 'tool_use', name: block.name, input: block.input };
              const fp = (block.input as { file_path?: string }).file_path;
              if (fp && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) yield { type: 'file_changed', path: fp };
            }
          }
        } else if (m.type === 'user') {
          const content = (m as { message: { content: unknown } }).message.content;
          if (Array.isArray(content)) for (const block of content as { type: string; tool_use_id?: string; content?: unknown }[]) if (block.type === 'tool_result') yield { type: 'tool_result', name: toolNames.get(block.tool_use_id ?? '') ?? 'unknown', output: block.content };
        } else if (m.type === 'result') {
          const cost = { usd: m.total_cost_usd, inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens };
          if (m.subtype === 'success') { yield { type: 'result', output: m.structured_output ?? { text: m.result }, summary: m.result.slice(0, 200), cost }; }
          else { const denials = m.permission_denials.length ? ` (${m.permission_denials.length} permission denials)` : ''; yield { type: 'error', message: `claude-code ended with ${m.subtype}${denials}`, cost }; }
          return;
        }
      }
      yield { type: 'error', message: 'claude-code ended without a result' };
    } catch (e) {
      yield { type: 'error', message: abort.signal.aborted ? 'aborted' : describeError(e) };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }
}
```
`src/index.ts` exporta adapter, tools-map, permissions. `TaskJob` em core ganha `budgetRemainingUsd?`, `outputSchema?`; o engine preenche `budgetRemainingUsd` quando `state.budgetUsd` existe (`Math.max(0, budgetUsd - spentUsd)`).

- [ ] **Step 4: Correr, commit**

```bash
git add packages/adapter-claude-code packages/core pnpm-lock.yaml
git commit -m "feat(adapter-claude-code): Claude Agent SDK runtime adapter with role tool rules and human approvals"
```

---

### Task 3: `@wizardingcode/shibaox-memory` — vault Obsidian e graphify

**Files:**
- Create: `packages/memory/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/vault.ts`, `src/graphify.ts`
- Modify: `packages/schemas/src/org.ts` (`OrgFileSchema` ganha `vault: z.string().optional()` — caminho relativo ao org root ou absoluto)
- Test: `packages/memory/test/vault.test.ts`, `packages/memory/test/graphify.test.ts`

**Interfaces:**
- Consumes: `RunState`, `StoredEvent`, `runArgv` (core); `Org`, `Workflow` (schemas).
- Produces:
```ts
// vault
interface VaultLayout { root: string }  // pastas: 00-org, 10-projects, 20-clients, 30-knowledge, 90-system
ensureVault(root: string): void   // cria as pastas se faltarem
writeRunNote(args: { vault: string; project: string; state: RunState; events: StoredEvent[]; workflow: Workflow; adapter: string }): { path: string }
  // 10-projects/<project>/runs/<YYYY-MM-DD>-<runId8>.md com frontmatter { type: run, run_id, project, workflow, status, adapter, spent_usd, started_at, finished_at, nodes: [...] } e corpo: resumo por nó (status, attempts, summary), relatório do último gate, decisões, links [[<project>]] [[workflow-<workflow>]] [[role-<role>]]; um ficheiro por run; se já existe, sufixo -2, -3 (nunca sobrescreve)
writeDecisionNote(args: { vault: string; project: string; state: RunState; nodeId: string }): { path: string }   // 90-system/decisions/<date>-<runId8>-<nodeId>.md
safeVaultPath(vault: string, rel: string): string   // reutiliza a regra de safePath (lança `path escapes vault`)
// graphify
interface GraphifyOptions { exec?: typeof runArgv; uvBin?: string /* 'uv' */ }
class Graphify {
  constructor(opts?: GraphifyOptions)
  async isInstalled(): Promise<boolean>               // `graphify --help` exit 0
  async ensureInstalled(): Promise<{ ok: boolean; message: string }>  // tenta `uv tool install graphifyy`; sem uv → { ok: false, message: 'uv not found: install uv (https://docs.astral.sh/uv/) then run: uv tool install graphifyy' }
  async pythonPath(): Promise<string | undefined>     // `uv tool run --from graphifyy python -c "import sys; print(sys.executable)"`
  async build(project: string): Promise<{ ok: boolean; graphJson?: string; message: string }>   // `graphify extract <project> --code-only`; graphJson = <project>/graphify-out/graph.json quando existe
  async update(project: string): Promise<{ ok: boolean; message: string }>                      // `graphify update <project>`
  async query(project: string, question: string, budget = 1500): Promise<string>               // `graphify query "<q>" --graph <json> --budget N`
  mcpServerConfig(graphJson: string, python: string): { type: 'stdio'; command: string; args: string[] }   // { command: python, args: ['-m', 'graphify.serve', graphJson] }
}
graphJsonPath(project: string): string   // <project>/graphify-out/graph.json
```
Todas as operações do graphify devolvem `{ ok, message }` e nunca lançam por falta da ferramenta (Review Focus 4).

- [ ] **Step 1: Testes (falham)**

`test/vault.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, StoredEvent } from '@wizardingcode/shibaox-core';
import { WorkflowSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { ensureVault, safeVaultPath, writeDecisionNote, writeRunNote } from '../src/index.js';

const wf = WorkflowSchema.parse({ workflow: 'hello-feature', start: 'a', nodes: { a: { type: 'task', role: 'backend', next: 'j' }, j: { type: 'decide', by: 'team-leader', options: ['ship', 'rework'], next: { ship: 'h', rework: 'a' } }, h: { type: 'human', action: 'ok' } } });
const at = '2026-09-26T10:00:00.000Z';
const state: RunState = { runId: 'abcdef1234567890', workflow: 'hello-feature', input: { spec: 'add /health' }, workspace: '/w', status: 'completed', nodes: { a: { status: 'completed', attempts: 2, summary: 'added route' }, j: { status: 'completed', attempts: 1, choice: 'ship' }, h: { status: 'completed', attempts: 1 } }, spentUsd: 0.42, budgetWarned: false, pendingHumans: [], lastGateReport: { gates: ['tests'], passed: true, checks: [{ name: 'unit-tests', type: 'code', passed: true, skipped: false, evidence: 'exit 0' }] } };
const events: StoredEvent[] = [{ seq: 1, type: 'RunCreated', runId: state.runId, at, workflow: 'hello-feature', input: state.input, workspace: '/w' }, { seq: 2, type: 'RunCompleted', runId: state.runId, at: '2026-09-26T10:05:00.000Z' }];

describe('vault', () => {
  it('ensureVault creates the layout', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    ensureVault(v);
    for (const d of ['00-org', '10-projects', '20-clients', '30-knowledge', '90-system']) expect(existsSync(join(v, d))).toBe(true);
  });
  it('writes a run note with frontmatter and wikilinks, never overwriting', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const { path } = writeRunNote({ vault: v, project: 'sample-repo', state, events, workflow: wf, adapter: 'direct' });
    expect(path).toBe(join(v, '10-projects', 'sample-repo', 'runs', '2026-09-26-abcdef12.md'));
    const md = readFileSync(path, 'utf8');
    expect(md.startsWith('---\ntype: run\n')).toBe(true);
    expect(md).toContain('run_id: abcdef1234567890');
    expect(md).toContain('spent_usd: 0.42');
    expect(md).toContain('[[sample-repo]]');
    expect(md).toContain('[[workflow-hello-feature]]');
    expect(md).toContain('[[role-backend]]');
    expect(md).toContain('added route');
    expect(md).toContain('choice: ship');
    const second = writeRunNote({ vault: v, project: 'sample-repo', state, events, workflow: wf, adapter: 'direct' });
    expect(second.path.endsWith('-2.md')).toBe(true);
  });
  it('writes a decision note under 90-system', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    const { path } = writeDecisionNote({ vault: v, project: 'sample-repo', state, nodeId: 'j' });
    expect(path).toContain(join('90-system', 'decisions'));
    expect(readFileSync(path, 'utf8')).toContain('ship');
  });
  it('refuses paths outside the vault', () => {
    const v = mkdtempSync(join(tmpdir(), 'vault-'));
    expect(() => safeVaultPath(v, '../x.md')).toThrow(/escapes vault/);
  });
});
```

`test/graphify.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { runArgv } from '@wizardingcode/shibaox-core';
import { describe, expect, it } from 'vitest';
import { Graphify, graphJsonPath } from '../src/index.js';

type Exec = typeof runArgv;
const fakeExec = (script: (argv: string[]) => { exitCode: number; stdout?: string; stderr?: string }): Exec => async ({ argv }) => { const r = script(argv); return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false }; };

describe('Graphify (fake exec)', () => {
  it('reports not installed and explains how to install when uv is missing', async () => {
    const g = new Graphify({ exec: fakeExec((argv) => (argv[0] === 'graphify' ? { exitCode: 127 } : argv[0] === 'uv' ? { exitCode: 127 } : { exitCode: 0 })) });
    expect(await g.isInstalled()).toBe(false);
    const r = await g.ensureInstalled();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('uv tool install graphifyy');
  });
  it('build runs extract --code-only and returns the graph path when produced', async () => {
    const project = mkdtempSync(join(tmpdir(), 'p-'));
    const calls: string[][] = [];
    const g = new Graphify({ exec: fakeExec((argv) => { calls.push(argv); return { exitCode: 0, stdout: 'ok' }; }) });
    const r = await g.build(project);
    expect(calls.some((c) => c[0] === 'graphify' && c[1] === 'extract' && c.includes('--code-only'))).toBe(true);
    expect(r.ok).toBe(false); // no graph.json was produced by the fake
    expect(r.message).toContain('graph.json');
  });
  it('mcpServerConfig points python at graphify.serve', () => {
    expect(new Graphify().mcpServerConfig('/p/graphify-out/graph.json', '/usr/bin/python3')).toEqual({ type: 'stdio', command: '/usr/bin/python3', args: ['-m', 'graphify.serve', '/p/graphify-out/graph.json'] });
  });
});

const hasGraphify = (() => { try { execFileSync('graphify', ['--help'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!hasGraphify)('Graphify (real, local AST only)', () => {
  it('builds a graph for the sample repo and answers a query', async () => {
    const sample = fileURLToPath(new URL('../../../examples/sample-repo', import.meta.url));
    const project = mkdtempSync(join(tmpdir(), 'gp-'));
    cpSync(sample, project, { recursive: true });
    const g = new Graphify();
    const r = await g.build(project);
    expect(r.ok, r.message).toBe(true);
    expect(existsSync(graphJsonPath(project))).toBe(true);
    const answer = await g.query(project, 'what does add do?');
    expect(answer.length).toBeGreaterThan(0);
  }, 120_000);
});
```

- [ ] **Step 2: Implementar**

`src/vault.ts`: `ensureVault`, `safeVaultPath` (mesma lógica de `safePath` do adapter-direct: `resolve`, `relative`, `realpath` do ancestral existente), `writeRunNote`, `writeDecisionNote`. Frontmatter escrito à mão (chave: valor por linha; listas com `- `); corpo em markdown com secções `## Summary`, `## Nodes` (tabela id | status | attempts | summary/choice), `## Last gate report`, `## Timeline` (evento por linha: `at type nodeId`), `## Links`. Nome de ficheiro: `${date}-${runId.slice(0,8)}.md`; se existir, `-2`, `-3`, …; datas de `events[0].at` e do último evento.

`src/graphify.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runArgv } from '@wizardingcode/shibaox-core';

export const graphJsonPath = (project: string) => join(project, 'graphify-out', 'graph.json');

export class Graphify {
  private readonly exec: typeof runArgv;
  private readonly uv: string;
  constructor(opts: { exec?: typeof runArgv; uvBin?: string } = {}) { this.exec = opts.exec ?? runArgv; this.uv = opts.uvBin ?? 'uv'; }
  private run(argv: string[], cwd = process.cwd(), timeoutMs = 600_000) { return this.exec({ argv, cwd, timeoutMs }); }
  async isInstalled(): Promise<boolean> { const r = await this.run(['graphify', '--help'], process.cwd(), 20_000); return r.exitCode === 0; }
  async ensureInstalled(): Promise<{ ok: boolean; message: string }> {
    if (await this.isInstalled()) return { ok: true, message: 'graphify is installed' };
    const uv = await this.run([this.uv, '--version'], process.cwd(), 20_000);
    if (uv.exitCode !== 0) return { ok: false, message: 'uv not found: install uv (https://docs.astral.sh/uv/) then run: uv tool install graphifyy' };
    const r = await this.run([this.uv, 'tool', 'install', 'graphifyy']);
    return r.exitCode === 0 ? { ok: true, message: 'installed graphifyy with uv' } : { ok: false, message: `uv tool install graphifyy failed: ${r.stderr.slice(-500)}` };
  }
  async pythonPath(): Promise<string | undefined> {
    const r = await this.run([this.uv, 'tool', 'run', '--from', 'graphifyy', 'python', '-c', 'import sys; print(sys.executable)'], process.cwd(), 60_000);
    return r.exitCode === 0 ? r.stdout.trim() : undefined;
  }
  async build(project: string) {
    const r = await this.run(['graphify', 'extract', project, '--code-only'], project);
    if (r.exitCode !== 0) return { ok: false, message: `graphify extract failed: ${(r.stderr || r.stdout).slice(-500)}` };
    const graphJson = graphJsonPath(project);
    return existsSync(graphJson) ? { ok: true, graphJson, message: 'graph built' } : { ok: false, message: `graphify extract finished but ${graphJson} was not produced` };
  }
  async update(project: string) {
    const r = await this.run(['graphify', 'update', project], project);
    return r.exitCode === 0 ? { ok: true, message: 'graph updated' } : { ok: false, message: `graphify update failed: ${(r.stderr || r.stdout).slice(-500)}` };
  }
  async query(project: string, question: string, budget = 1500): Promise<string> {
    const r = await this.run(['graphify', 'query', question, '--graph', graphJsonPath(project), '--budget', String(budget)], project, 120_000);
    return r.exitCode === 0 ? r.stdout.trim() : `graph query failed: ${(r.stderr || r.stdout).slice(-300)}`;
  }
  mcpServerConfig(graphJson: string, python: string) { return { type: 'stdio' as const, command: python, args: ['-m', 'graphify.serve', graphJson] }; }
}
```

- [ ] **Step 3: Correr, commit**

```bash
git add packages/memory packages/schemas pnpm-lock.yaml
git commit -m "feat(memory): Obsidian vault run notes and graphify runner with MCP config"
```

---

### Task 4: Runtime direto — `graph_query`, modo só-texto, ferramentas por capacidade, progresso, opções curtas

**Files:**
- Modify: `packages/adapter-direct/src/adapter.ts`, `src/tools.ts`; `packages/providers/src/catalog-schema.ts` (+ `capabilities: { tools: boolean }` default `{ tools: true }`), `catalog.yaml` (marcar `capabilities: { tools: false }` em modelos conhecidos sem tools? nenhum por defeito; documentar), `packages/schemas/src/role.ts` (nada), `packages/core/src/executors/types.ts` (`ExecutionContext.progress?: (line: string) => void` — não: usar `ctx.log`)
- Test: `packages/adapter-direct/test/adapter.test.ts`, `test/tools.test.ts`

**Interfaces:**
- `DirectAdapterOptions` ganha `graphQuery?: (question: string) => Promise<string>` → tool `graph_query` só quando definido.
- `buildTools` recebe `capabilities: Capability[]` derivadas de `role.capabilities`: se inclui `'read-only'` (ou `role.capabilities` está vazio E `role.tools` está vazio? não: só a flag explícita), omite `write_file` e `run_command`.
- Modo só-texto: `ProviderRegistry.supportsTools(ref): boolean` lê `entry.capabilities.tools`; quando falso, o adaptador chama `generate` sem tools e devolve `result { output: { text } }`.
- Progresso: cada `tool_use` faz `ctx.log('[direct] <tool> <resumo do input a 120 chars>')`; `file_changed` faz `ctx.log('[direct] wrote <path>')`.
- Opções curtas agrupadas: em `leavesWorkspace`, para um token que começa por `-` e não por `--`, verificar cada sufixo a partir de cada posição (`-rf../x` → analisar `../x`); regra: se o token contém `..` como segmento em qualquer sufixo após um separador `/`, ou contém `/` absoluto após letras de opção, recusar. Implementação simples: `const m = /^-[A-Za-z]+(.*)$/.exec(tok); if (m && m[1] && leavesWorkspace(m[1])) return true;`.

- [ ] **Step 1: Testes (falham)**

Adicionar a `test/adapter.test.ts`:
```ts
it('exposes graph_query when a query function is given and logs progress', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  const logs: string[] = [];
  fake = await startFakeOpenAI((_r, turn) => turn === 0 ? { toolCalls: [{ name: 'graph_query', args: { question: 'who calls add?' } }] } : { toolCalls: [{ name: 'finish', args: { output: { ok: true }, summary: 'done' } }] });
  const adapter = new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m', graphQuery: async (q) => `answer to ${q}` });
  const r = await collectRun(adapter, jobFor(ws), { signal: new AbortController().signal, log: (l) => logs.push(l) });
  expect(r.output).toEqual({ ok: true });
  expect(logs.some((l) => l.includes('[direct] graph_query'))).toBe(true);
  const sent = JSON.stringify(fake.requests[1]);
  expect(sent).toContain('answer to who calls add?');
});
it('runs text-only for models without tool support', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  fake = await startFakeOpenAI((req) => ({ content: (req.tools?.length ?? 0) > 0 ? 'TOOLS WERE SENT' : 'plain answer' }));
  const reg = new ProviderRegistry([{ id: 'fake', name: 'Fake', kind: 'openai-compatible', base_url: fake.baseURL, auth: { type: 'none' }, models: [], pricing: {}, verify: false, capabilities: { tools: false } }], {});
  const r = await collectRun(new DirectAdapter({ registry: reg, resolveRef: () => 'fake/m' }), jobFor(ws), ctx());
  expect(r.output).toEqual({ text: 'plain answer' });
});
it('read-only roles get no write_file or run_command', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'ws-'));
  fake = await startFakeOpenAI((req) => ({ content: JSON.stringify((req.tools as { function: { name: string } }[]).map((t) => t.function.name)) }));
  const job = { ...jobFor(ws, ['echo']), role: RoleSchema.parse({ role: 'analyst', capabilities: ['read-only'], tools: ['echo'] }) };
  const r = await collectRun(new DirectAdapter({ registry: registry(fake.baseURL), resolveRef: () => 'fake/m' }), job, ctx());
  const names = JSON.parse((r.output as { text: string }).text) as string[];
  expect(names).toEqual(expect.arrayContaining(['list_files', 'read_file', 'finish']));
  expect(names).not.toContain('write_file');
  expect(names).not.toContain('run_command');
});
```
`test/tools.test.ts` (novo): `leavesWorkspace('-rf../x')` é true; `leavesWorkspace('-rf')` false; `leavesWorkspace('-o./out')` false; `leavesWorkspace('-o/etc/x')` true.

- [ ] **Step 2: Implementar** conforme as interfaces acima (`leavesWorkspace` exportado de `tools.ts` para o teste).

- [ ] **Step 3: Correr, commit**

```bash
git add packages/adapter-direct packages/providers
git commit -m "feat(adapter-direct): graph_query tool, text-only models, capability-gated tools, progress logs, short-option guard"
```

---

### Task 5: Core — autorouting v0, adaptador persistido, Jev endurecido, diff no estado dos checks

**Files:**
- Create: `packages/core/src/run/autorouting.ts` (+ export)
- Modify: `packages/schemas/src/events.ts` (`RunCreated.adapter?: string`, `RunCreated.workspaceMode?: 'inplace' | 'worktree'`), `packages/core/src/run/{state,reducer,engine}.ts` (`RunState.adapter?`, `start({ adapter, workspaceMode })`), `packages/jev/src/decider.ts`, `packages/jev/src/check-runner.ts`, `packages/providers/src/judge.ts`, `packages/core/src/gates/engine.ts` (`CheckContext.diff?: () => Promise<string>`)
- Test: `packages/core/test/autorouting.test.ts`, `packages/core/test/engine.test.ts`, `packages/jev/test/decider.test.ts`, `packages/jev/test/check-runner.test.ts`, `packages/providers/test/judge.test.ts`

**Interfaces:**
```ts
// autorouting (core, pure; the Jev call is injected)
interface CapabilityCandidate { id: string; type: 'skill' | 'plugin' | 'mcp' | 'tool'; description: string; tags: string[] }
interface AutorouteArgs { request: string; role: Role; team?: Team; catalog: CatalogEntry[]; fanOut?: (state: string, questions: Record<string, { instructions: string }>) => Promise<Record<string, { noul?: number }>>; thresholds?: { attach: number /* 0.8 */; ask: number /* 0.5 */ } }
interface AutorouteResult { attach: string[]; ambiguous: string[]; dropped: string[]; cost?: Cost }
selectCapabilities(args): Promise<AutorouteResult>
  // prefilter: catálogo × (tags que interceptam role.capabilities ou role.tools ou team.roles) — se não há tags em comum mantém-se o candidato; máximo 40 candidatos; sem fanOut → attach = candidatos com tag exata ao papel, ambiguous = resto (modo determinístico)
  // com fanOut: um noul por candidato "The capability <id> (<description>) is needed for this request"; ≥ attach → attach; ≥ ask → ambiguous; senão dropped
```
- `RunEngine.start` aceita `adapter?: string` e `workspaceMode?` e grava-os em `RunCreated`; `RunState.adapter`; `resume` na CLI usa `state.adapter` quando `--adapter` não é passado (fecha a dívida de 1B-1).
- `JevDecider`: abaixo do limiar **sem** fallback → `throw new Error('jev decision below confidence threshold (<c> < <t>) and no fallback decider configured')`; estado enviado via `truncateState({ spec: question+input, output: previousOutputs, diff: lastGateReport })`.
- `CheckContext.diff?: () => Promise<string>`: o engine preenche com `diffRunWorkspace(state.workspace)` quando `@wizardingcode/shibaox-workspace` está disponível? Core não depende de workspace: o `EngineDeps` ganha `diffProvider?: (workspace: string) => Promise<string>` que a CLI liga a `diffRunWorkspace`. `jevCheckRunner` e `judgeCheckRunner` incluem `diff` (truncado) e `lastGateReport` no estado.

- [ ] **Step 1: Testes (falham)**

`packages/core/test/autorouting.test.ts`:
```ts
import { CatalogEntrySchema, RoleSchema, TeamSchema } from '@wizardingcode/shibaox-schemas';
import { describe, expect, it } from 'vitest';
import { selectCapabilities } from '../src/index.js';

const catalog = [
  CatalogEntrySchema.parse({ id: 'graphify-mcp', type: 'mcp', description: 'Knowledge graph of the codebase', tags: ['code', 'backend', 'analyst'] }),
  CatalogEntrySchema.parse({ id: 'figma-mcp', type: 'mcp', description: 'Design files', tags: ['design'] }),
  CatalogEntrySchema.parse({ id: 'tdd-skill', type: 'skill', description: 'Test-driven development', tags: ['backend', 'write-code'] }),
];
const role = RoleSchema.parse({ role: 'backend', capabilities: ['write-code'], tools: ['git'] });

describe('selectCapabilities', () => {
  it('deterministic mode attaches exact role/capability tag matches and marks the rest ambiguous', async () => {
    const r = await selectCapabilities({ request: 'add /health endpoint', role, catalog });
    expect(r.attach.sort()).toEqual(['graphify-mcp', 'tdd-skill']);
    expect(r.ambiguous).toEqual(['figma-mcp']);
  });
  it('with a fan-out, applies thresholds and never attaches below them or outside the catalog', async () => {
    const fanOut = async (_s: string, q: Record<string, unknown>) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.includes('graphify') ? 0.95 : k.includes('tdd') ? 0.6 : 0.1 }]));
    const r = await selectCapabilities({ request: 'add /health endpoint', role, catalog, fanOut });
    expect(r.attach).toEqual(['graphify-mcp']);
    expect(r.ambiguous).toEqual(['tdd-skill']);
    expect(r.dropped).toEqual(['figma-mcp']);
  });
  it('caps candidates at 40 and prefers tag matches', async () => {
    const many = Array.from({ length: 60 }, (_, i) => CatalogEntrySchema.parse({ id: `s${i}`, type: 'skill', description: `skill ${i}`, tags: i < 5 ? ['backend'] : ['other'] }));
    const r = await selectCapabilities({ request: 'x', role, catalog: many, fanOut: async (_s, q) => Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.9 }])) });
    expect(r.attach.length + r.ambiguous.length + r.dropped.length).toBeLessThanOrEqual(40);
    expect(r.attach).toEqual(expect.arrayContaining(['s0', 's1', 's2', 's3', 's4']));
  });
});
```
Engine: `start({ adapter: 'direct', workspaceMode: 'worktree' })` → `RunCreated.adapter === 'direct'` e `state.adapter === 'direct'`.
Jev decider: abaixo do limiar sem fallback → rejeita com `no fallback decider`; o estado enviado (`fake.requests[0].state`) contém `## spec` e `## output`.
Check runners: com `ctx.diff = async () => 'diff --git a/x b/x'` o estado enviado ao Jev contém `## diff` e `diff --git`; o judge inclui `## diff` na mensagem.

- [ ] **Step 2: Implementar** conforme as interfaces.

- [ ] **Step 3: Correr, commit**

```bash
git add packages/core packages/schemas packages/jev packages/providers
git commit -m "feat(core,jev): autorouting v0, adapter persisted in RunCreated, stricter jev decider, diff in check state"
```

---

### Task 6: CLI — `--adapter claude-code`, `--workspace`, `graph`, `worktree`, nota no vault, e2e

**Files:**
- Modify: `apps/cli/src/wiring.ts`, `apps/cli/src/commands/{run,resume}.ts`, `apps/cli/src/index.ts`, `apps/cli/src/templates.ts` (`org.yaml` ganha `vault: ../vault`), `apps/cli/package.json`, `apps/cli/vitest.config.ts`, `README.md`
- Create: `apps/cli/src/commands/graph.ts`, `apps/cli/src/commands/worktree.ts`
- Test: `apps/cli/test/run-claude-code-e2e.test.ts`, `apps/cli/test/graph.test.ts`, `apps/cli/test/wiring.test.ts` (ampliar)

**Interfaces / comportamento:**
- `buildRuntime` regista `claude-code: new ClaudeCodeAdapter({ human, orgRoot, model: (job) => resolveModel(...) → model quando `kind: 'runtime'`, mcpServers: (job) => autorouting attach ⊇ 'graphify-mcp' && graph exists ? { graphify: graphify.mcpServerConfig(...) } : {}, queryFn: o.queryFn (injetável para testes) })`. `--adapter` passa a `.choices(['mock', 'direct', 'claude-code'])`. Para `claude-code`, a verificação pré-run resolve cada papel com `resolveModel` e exige `kind: 'runtime' && runtime === 'claude-code'` ou `direct` (papéis mistos são permitidos: cada nó usa o seu `kind`); `EngineDeps.adapters` recebe ambos e o engine escolhe por nó: adicionar a `RunEngine` a regra "se `defaultAdapter` é `claude-code` e o papel resolve para `direct`, usa `direct`" via um `adapterFor(job) => string` opcional em `EngineDeps` (a CLI fornece-o com base em `resolveModel`).
- `run --workspace <inplace|worktree>` (default `worktree` quando `isGitRepo(project)`, senão `inplace`); a CLI cria o workspace antes de `engine.start({ workspace: ws.path, workspaceMode })`; no fim imprime `worktree: <path> (branch shibaox/<runId>)`; `shibaox worktree list --project`, `shibaox worktree rm <runId> --project [--delete-branch]`.
- `EngineDeps.diffProvider = diffRunWorkspace`.
- Vault: `org.yaml vault` resolvido relativo ao org root; após `run`/`resume` terminar (`completed`, `failed`, `cancelled`), `writeRunNote` e, por cada nó `decide`, `writeDecisionNote`; imprime `note: <path>`. Sem `vault` configurado → aviso único.
- `shibaox graph build|update --project <path>` e `shibaox graph query "<q>" --project <path>`; `run` com `--graph` (default `auto`: usa o grafo se `graphify-out/graph.json` existe, não constrói sozinho) liga `graphQuery` no DirectAdapter e o MCP no ClaudeCodeAdapter.
- `resume` sem `--adapter` usa `state.adapter`.
- `process.exitCode` em vez de `process.exit` após `printState`.
- README: secções "Claude Code runtime" (subscrição vs API key, `approval_required`, o que é negado), "Worktrees", "Memory (vault + graphify)", "Autorouting".

- [ ] **Step 1: Testes (falham)**

`apps/cli/test/run-claude-code-e2e.test.ts`: org do `init` com `models.yaml` `tiers.strong: anthropic-subscription/claude-sonnet-5` e `adapter: claude-code`; projeto = cópia do sample repo inicializada como git repo; `runWorkflow('hello-feature', { adapter: 'claude-code', workspace: 'worktree', queryFn: fakeQuery(...) , human: AutoApproveHuman, env: {} , vault: <tmp vault> })` com um fake que devolve `msg.success('implemented')` para cada tarefa → `status completed`, `RunCreated.adapter === 'claude-code'`, `RunCreated.workspace` termina em `.shibaox/worktrees/<runId>`, `q.calls[0].options.cwd` igual, nota escrita em `<vault>/10-projects/<proj>/runs/`. Segundo caso: `human: DeferHuman` e o fake pede `git push` via `canUseTool` → o teste verifica que `options.canUseTool` devolve `deny` com `interrupt` (chamar diretamente `q.calls[0].options.canUseTool!('Bash', { command: 'git push' }, { signal })`).
`apps/cli/test/graph.test.ts`: `graph build` com `Graphify` fake (exec injetado) imprime a mensagem de falha sem lançar; `graph query` devolve o texto.

- [ ] **Step 2: Implementar** conforme acima; `RunOptions` ganha `workspace?`, `graph?`, `queryFn?`, `vault?` (override para testes).

- [ ] **Step 3: Correr tudo e run real opcional**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`.
Run manual com o CLI `claude` autenticado (subscrição): `init`, editar `org.yaml` `adapter: claude-code` e `models.yaml` `strong: anthropic-subscription/claude-sonnet-5`, `graph build --project examples/sample-repo`, `run hello-feature --org … --project examples/sample-repo --input "add a subtract function with a test"`; esperado: worktree criado, run `completed` (ou `waiting_human` sem TTY), nota no vault, `spentUsd > 0`. Registar o resultado real obtido.

- [ ] **Step 4: Commit**

```bash
git add apps/cli README.md pnpm-lock.yaml
git commit -m "feat(cli): claude-code adapter, worktrees, graph and worktree commands, vault run notes"
```

---

## Self-review

**Cobertura da spec 1B (secções 5, 6, 2 texto-só) e backlog:** adaptador Claude Code (systemPrompt preset+append, cwd, allowedTools por papel, canUseTool com aprovação humana, maxBudgetUsd, mcpServers, outputFormat, settingSources [], abort) → Task 2; worktree por run → Task 1; vault writer + graphify (ensure, build, update, query, MCP) → Task 3; `graph_query` no runtime direto, modo só-texto, ferramentas por capacidade, progresso, opções curtas → Task 4; autorouting v0, adaptador persistido, JevDecider estrito e truncado, diff no estado dos checks → Task 5; CLI, vault no fim do run, `process.exitCode`, README → Task 6. `LlmClient.stream()` fica deliberadamente fora (nenhum consumidor); a aprovação humana persistente para tarefas do Claude Code sem TTY fica para o control plane (fase 2).

**Review Focus → testes:** (1) `permissions.test.ts` "denies with interrupt when the human defers" + e2e; (2) `worktree.test.ts` "never touches the main checkout" e "refuses worktree mode outside a git repo"; (3) `vault.test.ts` "never overwriting" e "refuses paths outside"; (4) `graphify.test.ts` "reports not installed…" e `graph.test.ts`; (5) `autorouting.test.ts` "never attaches below thresholds or outside the catalog".

**Consistência de nomes:** `createRunWorkspace/listRunWorkspaces/removeRunWorkspace/diffRunWorkspace/isGitRepo`, `ClaudeCodeAdapter/mapRoleTools/buildCanUseTool/classifyToolRequest/fakeQuery/msg`, `ensureVault/writeRunNote/writeDecisionNote/safeVaultPath/Graphify/graphJsonPath`, `selectCapabilities`, `EngineDeps.diffProvider/adapterFor`, `RunCreated.adapter/workspaceMode`, `TaskJob.budgetRemainingUsd/outputSchema`.
