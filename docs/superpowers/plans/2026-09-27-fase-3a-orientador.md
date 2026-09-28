# Fase 3A — Orientador Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the chat of the dashboard becomes an orchestrator that keeps a real conversation, acts with tools (files, commands, web), dispatches org workflows as child runs shown in the same thread, knows the project (profile) and remembers (vault notes).

**Architecture:** structured `messages` travel in `RunCreated.input`; adapters get three new hooks (`preamble`, `extraTools`, role limits) and the daemon wires orchestration/memory tools into them through one adapter-agnostic `AgentTool` shape (AI SDK tool for `direct`, in-process MCP server for `claude-code`). Child runs carry `parentRunId`; the TUI attaches them to the parent's thread and continues the conversation with an `[event]` message when they end.

**Tech Stack:** TypeScript strict, zod 4, vitest (packages), bun test (TUI), AI SDK `tool()`, `@anthropic-ai/claude-agent-sdk` `createSdkMcpServer`/`tool`.

**Spec:** `docs/superpowers/specs/2026-09-27-shibaox-3a-orientador-design.md`

## Global Constraints

- `pnpm build && pnpm test && pnpm lint` green; biome: 0 errors (the 9 accepted `noNonNullAssertion` warnings may stay).
- Bun (TUI) never imports `better-sqlite3`/daemon runtime code (boundary test).
- Adapters never receive the shibaox API keys beyond what they already get; `web_fetch` uses a scrubbed request (no cookies, no auth headers).
- Existing event logs must replay: every schema addition is optional.
- All user-facing copy in the TUI stays in English (the product language), the assistant answers in the user's language.

## Review Focus

1. A `messages` array with a malformed entry (missing role) must be ignored, not crash the adapter — test in Task 2/3 (`conversationOf`).
2. `web_fetch` with a URL whose host is not in `network` must be refused with a clear error; `network: ['*']` allows any host; redirects to a disallowed host are refused (fetch with `redirect: 'manual'`) — Task 2.
3. A child run whose parent tab was closed must not resurrect the tab; it stays a normal run in `/runs` — Task 7.
4. `start_workflow` with an unknown workflow returns `{ error }` to the model (never throws out of the run) — Task 6.
5. `profileProject` on a huge directory (home) stops at 20 000 files and never follows symlinks — Task 4.

---

### Task 1: Schemas and core — `parentRunId`, role limits, `ChatMessage`

**Files:**
- Modify: `packages/schemas/src/events.ts` (RunCreated `parentRunId: z.string().optional()`), `packages/schemas/src/role.ts` (`max_steps`, `max_turns`, `budget_usd`), `packages/schemas/src/common.ts` (`ChatMessageSchema`, `ChatMessage`)
- Modify: `packages/core/src/run/state.ts` (`parentRunId?: string`), `packages/core/src/run/reducer.ts` (copy on RunCreated), `packages/core/src/run/engine.ts` (`StartOptions.parentRunId`, emitted), `packages/core/src/executors/types.ts` (`AgentTool`, `conversationOf`)
- Test: `packages/schemas/test/role.test.ts` (new), `packages/core/test/reducer-3a.test.ts` (new)

**Interfaces:**
- Produces: `ChatMessage = { role: 'user'|'assistant'; content: string }`; `conversationOf(input: Record<string, unknown>): ChatMessage[]` (reads `input.messages`, keeps only well-formed entries); `AgentTool = { name: string; description: string; input: z.ZodObject<any>; execute(input: unknown): Promise<unknown> }`; `Role.max_steps?`, `Role.max_turns?`, `Role.budget_usd?`; `RunState.parentRunId?`.

- [ ] **Step 1: failing tests**

```ts
// packages/schemas/test/role.test.ts
import { describe, expect, it } from 'vitest';
import { ChatMessageSchema, RoleSchema } from '../src/index.js';
describe('RoleSchema limits', () => {
  it('accepts per-role limits and rejects non-positive ones', () => {
    const r = RoleSchema.parse({ role: 'a', max_steps: 40, max_turns: 80, budget_usd: 1.5 });
    expect([r.max_steps, r.max_turns, r.budget_usd]).toEqual([40, 80, 1.5]);
    expect(() => RoleSchema.parse({ role: 'a', max_steps: 0 })).toThrow();
  });
  it('ChatMessageSchema keeps role and content only', () => {
    expect(ChatMessageSchema.parse({ role: 'user', content: 'hi', extra: 1 })).toEqual({ role: 'user', content: 'hi' });
  });
});
// packages/core/test/reducer-3a.test.ts
it('RunCreated.parentRunId lands in the state', () => {
  const s = replay([{ type:'RunCreated', runId:'c', at:'t', workflow:'w', input:{}, workspace:'/w', parentRunId:'p', seq:1 } as never]);
  expect(s.parentRunId).toBe('p');
});
it('conversationOf keeps well-formed messages only', () => {
  expect(conversationOf({ messages: [{ role: 'user', content: 'a' }, { role: 'x', content: 'b' }, 'junk'] })).toEqual([{ role: 'user', content: 'a' }]);
  expect(conversationOf({})).toEqual([]);
});
```

- [ ] **Step 2: run, watch fail** — `pnpm --filter @wizardingcode/shibaox-schemas test`, `pnpm --filter @wizardingcode/shibaox-core test -- reducer-3a`. Expected: FAIL (unknown export / undefined).
- [ ] **Step 3: implement** (schema fields optional; reducer copies `event.parentRunId`; engine `create` emits `parentRunId: opts.parentRunId`; `conversationOf` filters with `ChatMessageSchema.safeParse`).
- [ ] **Step 4: run, watch pass**; then `pnpm --filter @wizardingcode/shibaox-schemas --filter @wizardingcode/shibaox-core build`.
- [ ] **Step 5: commit** `feat(core): parentRunId, per-role limits, chat messages and the AgentTool shape`

---

### Task 2: Direct adapter — conversation, write gating, limits, `web_fetch`, `extraTools`, `preamble`

**Files:**
- Create: `packages/adapter-direct/src/web.ts` (`hostAllowed(hostname, allow: string[])`, `fetchText(url, { timeoutMs, maxBytes })`)
- Modify: `packages/adapter-direct/src/adapter.ts`, `packages/adapter-direct/src/tools.ts`
- Test: `packages/adapter-direct/test/web.test.ts` (new), `packages/adapter-direct/test/adapter.test.ts`, `packages/adapter-direct/test/tools.test.ts`

**Interfaces:**
- Consumes: `conversationOf`, `AgentTool`, `Role.max_steps/budget_usd`.
- Produces: `DirectAdapterOptions.preamble?: (job: TaskJob) => string | undefined`; `DirectAdapterOptions.extraTools?: (job: TaskJob) => AgentTool[]`; tool `web_fetch({ url })` → `{ status, contentType, text }`.

- [ ] **Step 1: failing tests**
  - `web.test.ts`: `hostAllowed('api.github.com', ['*'])` true; `['github.com']` matches `api.github.com` and `github.com`, not `evilgithub.com`; `[]` false. `fetchText` against a local `http.createServer` returns stripped text (`<h1>Hi</h1><script>x</script>` → `Hi`), refuses a 302 to another host, truncates at `maxBytes`.
  - `adapter.test.ts`: (a) "sends the conversation as prior turns": job `input: { spec:'and now?', messages:[{role:'user',content:'hello'},{role:'assistant',content:'hi'}] }` → the fake server receives messages `[system, user 'hello', assistant 'hi', user (contains 'Task:' and 'and now?')]` and the last user content does not contain `"messages"`. (b) "role.max_steps caps the loop": role `max_steps: 1`, model always calls `list_files` → error `max steps (1) reached without finish`. (c) "preamble goes into the system prompt": `preamble: () => 'Project: Node'` → system message contains it. (d) "extraTools are callable": `extraTools: () => [{ name:'ping', description:'', input: z.object({}), execute: async () => ({ pong: true }) }]`, model calls `ping` then `finish` → tool_result event `{ pong: true }`. (e) "budget_usd caps the job": role `budget_usd: 0.01` and `budgetRemainingUsd: 5` → the job budget passed to `generate` … (skip: direct has no per-call budget; instead assert nothing) — **drop (e)**, budget is enforced by the engine after the fact; document in the ledger.
  - `tools.test.ts`: "write_file exists only with `write`": role tools `['echo']` → no `write_file` key; `['write']` → present; role `capabilities:['read-only']` → absent even with `write`. "web_fetch appears only with network": `permissions.network: ['*']` → key present, else absent; a call with a disallowed host returns `{ error: 'host "x" is not allowed (network: …)' }`.
  - Update the existing tests that used `tools: ['echo']` and wrote files to `['write', 'echo']`.
- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement**
  - `adapter.ts`: `systemPrompt` appends `\n\n${preamble}` when given; `messages = [...conversationOf(job.input).map(m => ({ role: m.role, content: m.content })), { role:'user', content: userMessage(job) }]`; `userMessage` stringifies `input` without `messages`; `effectiveMaxSteps = supportsTools ? (job.role.max_steps ?? this.opts.maxSteps ?? 12) : 1`; pass `extraTools: this.opts.extraTools?.(job) ?? []` to `buildTools`.
  - `tools.ts`: `write_file` only when `!readOnly && role.tools.includes('write')`; `run_command` when `!readOnly` (unchanged); `web_fetch` when `role.permissions.network.length > 0` (uses `fetchText`, 15 000 ms, 200 000 bytes, `hostAllowed`); extra tools mapped with `tool({ description, inputSchema: t.input, execute: guarded(t.name, (i) => t.execute(i)) })`.
  - `web.ts`: `fetchText` = `fetch(url, { redirect:'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'shibaox' } })`; 3xx with a `location` → resolve, check `hostAllowed`, follow up to 3 times; read body as text, cap at `maxBytes`; if content-type html: drop `<script>…</script>`, `<style>…</style>`, tags, collapse whitespace.
- [ ] **Step 4: run, watch pass**, `pnpm --filter @wizardingcode/shibaox-adapter-direct build test`.
- [ ] **Step 5: commit** `feat(adapter-direct): conversation turns, write gating, per-role max_steps, web_fetch, extra tools and preamble`

---

### Task 3: Claude Code adapter — transcript, limits, network permission, in-process MCP, `preamble`

**Files:**
- Create: `packages/adapter-claude-code/src/mcp.ts` (`sdkMcpServer(name: string, tools: AgentTool[]): McpSdkServerConfigWithInstance` using `createSdkMcpServer` + `tool` from the SDK; the handler returns `{ content: [{ type:'text', text: JSON.stringify(result) }] }`, errors as `{ content:[{type:'text', text: JSON.stringify({ error }) }], isError: true }`)
- Modify: `adapter.ts` (`preamble`, `extraTools` → `mcpServers.shibaox`, `maxTurns = job.role.max_turns ?? opts.maxTurns ?? 60`, `maxBudgetUsd = min(role.budget_usd, budgetRemainingUsd)`, transcript in the prompt), `tools-map.ts` (`mapRoleTools` keeps `WebFetch`/`WebSearch` out of `disallowedTools` and adds them to `allowedTools` when `role.permissions.network.length > 0`), `permissions.ts` (`buildCanUseTool`: `WebFetch` allowed when `hostAllowed(new URL(input.url).hostname, role.permissions.network)`, `WebSearch` allowed when network non-empty), `index.ts` (export `sdkMcpServer`, `hostAllowed` moved to `@wizardingcode/shibaox-core`? — no: copy the 8-line matcher into `packages/core/src/executors/network.ts` as `hostAllowed` and use it from both adapters; Task 2 imports it from core too)
- Test: `adapter.test.ts`, `tools-map.test.ts`, `permissions.test.ts`, `mcp.test.ts` (new: the server instance lists the tool and calling its handler returns the JSON text)

- [ ] **Step 1: failing tests** — transcript: job with `messages` → `q.calls[0].prompt` starts with `Conversation so far:\nUser: hello\nAssistant: hi` and the `Input:` line has no `messages`; limits: role `max_turns: 7`, `budget_usd: 0.5` with `budgetRemainingUsd: 2` → `options.maxTurns === 7`, `options.maxBudgetUsd === 0.5`; preamble: `options.systemPrompt.append` contains it; extraTools: `options.mcpServers.shibaox` defined and `allowedTools` contains `mcp__shibaox__*`; tools-map: network `['*']` → `allowedTools` has `WebFetch`, `WebSearch`, `disallowedTools` lacks them; permissions: `WebFetch { url:'https://api.github.com/x' }` allowed with `['github.com']`, denied with `['example.com']`, denied with `[]`.
- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement** (see Files). Move `hostAllowed` to core first so Task 2's web.ts re-exports it.
- [ ] **Step 4: run, watch pass**, build.
- [ ] **Step 5: commit** `feat(adapter-claude-code): conversation transcript, per-role limits, web tools by network permission, in-process MCP tools and preamble`

---

### Task 4: Project profile (`@wizardingcode/shibaox-core`)

**Files:**
- Create: `packages/core/src/project/profile.ts`; export from `index.ts`
- Test: `packages/core/test/profile.test.ts`

**Interfaces:**
- Produces: `interface ProjectProfile { name: string; path: string; git: boolean; stack: string[]; packageManager?: string; testCommand?: string; files: number; truncated: boolean; languages: { ext: string; files: number }[]; summary: string }`; `profileProject(dir: string, o?: { maxFiles?: number }): ProjectProfile`; `renderProfileNote(p: ProjectProfile): string` (markdown with frontmatter `type: project-profile`).

- [ ] **Step 1: failing tests** — a temp dir with `package.json` `{ dependencies: { next: '1', react: '1' }, scripts: { test: 'vitest' } }` + `pnpm-lock.yaml` + `src/a.ts` `src/b.tsx` → stack `['Next.js', 'React', 'TypeScript']`, packageManager `pnpm`, testCommand `pnpm test`, files 4, summary `Next.js · React · TypeScript · pnpm test · 4 files`; `composer.json` with `laravel/framework` → `Laravel`, `PHP`; `go.mod` → `Go`; `Cargo.toml` → `Rust`; `pubspec.yaml` with `flutter:` → `Flutter`; `project.godot` → `Godot`; `manage.py` → `Django`; empty dir → stack `[]`, summary `'empty directory'`; `maxFiles: 3` on 10 files → `truncated: true`, `files: 3`; a symlink to a dir outside is not followed.
- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement** (walk with `lstatSync`, skip `node_modules .git vendor dist build .next target .shibaox`; languages by extension map ts/tsx→TypeScript, js/jsx/mjs→JavaScript, php, py→Python, go, rs→Rust, dart, cs→C#, gd→GDScript, rb→Ruby, java, kt→Kotlin, swift, vue, css, html, md; stack from markers; `detectTestCommand(dir)` reused; summary = `[...stack.slice(0,3), testCommand, `${files}${truncated?'+':''} files`].filter(Boolean).join(' · ')`).
- [ ] **Step 4: run, watch pass**, build.
- [ ] **Step 5: commit** `feat(core): project profile (stack, package manager, tests, size)`

---

### Task 5: Memory notes (`@wizardingcode/shibaox-memory`)

**Files:**
- Create: `packages/memory/src/notes.ts`; export from `index.ts`
- Test: `packages/memory/test/notes.test.ts`

**Interfaces:**
- Produces: `class MemoryNotes { constructor(o: { vault: string; project: string; now?: () => Date }); remember(scope: 'user'|'project', text: string): { path: string }; recall(query: string, limit = 20): { scope: 'user'|'project'; line: string }[]; preamble(o?: { profileSummary?: string; maxBytes?: number }): string }`.

- [ ] **Step 1: failing tests** — remember user → `00-org/memory.md` gets `- 2026-09-27 · uses pnpm` (frontmatter `type: memory` created once); remember project → `10-projects/<p>/memory.md`; recall `'pnpm'` finds it, `'PNPM packages'` (all words, any case) finds `uses pnpm for packages`, `'docker'` → `[]`; preamble includes both notes' tails and the profile summary, capped at `maxBytes` (keeps the end); a project name with `/` throws (`assertSafeId`).
- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement** with `safeVaultPath` + `ensureVault`.
- [ ] **Step 4: run, watch pass**, build.
- [ ] **Step 5: commit** `feat(memory): user and project memory notes with remember, recall and a prompt preamble`

---

### Task 6: Daemon — messages, parentRunId, orchestration + memory tools, preamble, profile endpoint, templates

**Files:**
- Create: `packages/daemon/src/runs/orchestration.ts` (`orchestrationTools(o: { runId; workflows: {name; description?}[]; current: string; startWorkflow(workflow, request): Promise<{ runId }> }): AgentTool[]`; `memoryTools(notes: MemoryNotes): AgentTool[]`), `packages/daemon/src/runs/profile.ts` (`profileFor(path, o: { vault?: string; cacheMs?: number }): ProjectProfile` with a Map cache and the note write)
- Modify: `run-manager.ts` (`SubmitRequest.messages?`, `parentRunId?`; `submit` stores `input: { spec, ...(messages && { messages }) }`, passes `parentRunId` to `engine.create`; `RunSummaryPlus.parentRunId`; `buildEngine` gets `tools` built per run: orchestration (workflows of the org, `startWorkflow` = `this.submit({ ...same org/project/adapter/workspace, workflow, input: request, parentRunId: runId })`), memory (`MemoryNotes` when the org has a vault), preamble (profile summary + notes.preamble())), `runtime.ts` (`RuntimeOptions.tools?: { extra?: (job: TaskJob) => AgentTool[]; preamble?: (job: TaskJob) => string | undefined }` → `DirectAdapter { extraTools, preamble }`, `ClaudeCodeAdapter { extraTools, preamble }`), `server.ts` (`GET /projects/profile?path&org`), `client.ts` (`projectProfile(path, orgRoot?)`), `templates.ts` (assistant role + prompt as in the spec), `inline.ts` (`messages` unchanged: CLI has no conversation; parentRunId not needed)
- Test: `packages/daemon/test/orchestration.test.ts` (new), `run-manager.test.ts`, `server.test.ts`

Tool gating: `extra(job)` returns orchestration tools when `job.role.capabilities.includes('orchestrate')` and memory tools when it includes `'memory'`.

- [ ] **Step 1: failing tests**
  - `orchestration.test.ts`: `start_workflow` description lists `hello-feature — Analyse, implement…` and not the current `chat`; execute with unknown workflow → `{ error: 'workflow "x" is not defined…' }`; execute with `hello-feature` calls `startWorkflow('hello-feature', 'add /health')` and returns `{ runId, workflow, status: 'queued' }`; `memoryTools`: `remember` then `recall` round-trip on a temp vault.
  - `run-manager.test.ts`: "submit records messages and parentRunId; list exposes parentRunId": submit mock with `messages:[{role:'user',content:'hi'}]`, `parentRunId: 'p'` → `RunCreated.input.messages` equals it and `RunCreated.parentRunId === 'p'`, `(await m.list()).find(r=>r.runId===runId)?.parentRunId === 'p'`. "a claude-code chat run gets the shibaox MCP server and the preamble": org with claude-code tiers, assistant role (capabilities `[orchestrate, memory]`), `queryFn` fake that captures options → `options.mcpServers.shibaox` defined, `options.systemPrompt.append` contains the profile summary line (project = sample repo → contains `files`).
  - `server.test.ts`: `GET /projects/profile?path=<sample>&org=<org>` → 200 with `summary` containing `files`, and `<vault>/10-projects/<name>/profile.md` exists; `path` missing → 400.
- [ ] **Step 2: run, watch fail.**
- [ ] **Step 3: implement.** Template `org/roles/assistant.yaml`:

```yaml
role: assistant
description: The orchestrator you talk to; it answers, acts, and dispatches the teams.
model_tier: cheap
capabilities: [orchestrate, memory]
tools: [read, write, git, node, npm, pnpm, bun, python3]
permissions:
  network: ['*']
  approval_required: [push, deploy]
max_steps: 40
max_turns: 80
system_prompt: prompts/assistant.md
```

`org/prompts/assistant.md`:

```md
# Orchestrator
You are the orchestrator of this organisation, talking with its owner inside shibaox.
Answer in the language the user writes in. Be direct; two or three lines unless asked for more.

Act. When the user asks for something, do it with your tools: read and write files in the
workspace, run the listed programs, fetch pages. Small work (a script, a fix, an answer, a
document) you do yourself, now. Larger work (a feature with tests, several parts, a review of
the whole codebase) you dispatch with `start_workflow` to the right workflow and tell the
user what you started; the run shows up in this same conversation. Never say you do not
implement changes.

Remember what matters with `remember` (user preferences → scope `user`, project decisions →
scope `project`) and look things up with `recall` before asking again.

Messages that start with `[event]` come from shibaox, not from the user: a dispatched run
finished or needs something. Summarise the outcome for the user in one or two lines.

Pushing, deploying and publishing are only done through approved tool calls.
```

- [ ] **Step 4: run, watch pass**, `pnpm --filter @wizardingcode/shibaox-daemon build test`.
- [ ] **Step 5: commit** `feat(daemon): conversation messages, child runs, orchestration and memory tools, project profile endpoint, orchestrator template`

---

### Task 7: TUI — conversation, chat rendering, child runs in the thread, profile line, home-dir workspace

**Files:**
- Modify: `apps/tui/src/context/client.tsx` (`projectProfile`), `apps/tui/src/testing/fake-client.ts` (`profiles: Map<string, ProjectProfile>`), `apps/tui/src/context/data.tsx` (`continueRun` sends `input: text`, `messages`; `attachChildren` effect on `state.runs`: a run with `parentRunId` in a thread and not yet listed → append + subscribe; `onChildEnded` → `continueRun(root, '[event] workflow X finished: status · N nodes · files · branch')` once per child (guard with a `Set`)), `apps/tui/src/model/stream.ts` (`isChatRun(state)`; `reduceTimeline` skips the summary card for a completed chat run), `apps/tui/src/routes/session/timeline.tsx` (pass `chat` to `NodeCard`; `RequestBlock` gets `child`), `apps/tui/src/routes/session/request.tsx` (`[event]` inputs render as one muted line `↳ <text without prefix>`; child runs render `→ <workflow>` before the request in the accent colour), `apps/tui/src/routes/session/cards.tsx` (`NodeCard` prop `chat?: boolean`: no header, no `■ done` footer, blocks only), `apps/tui/src/routes/home.tsx` (profile line via `createResource` on `[project, org]`; `project` = `~/.shibaox/workspace` when `cwd === HOME`), `apps/tui/src/routes/session/index.tsx` (child runs count in `detail()` is not needed — skip)
- Test: `apps/tui/test/thread.test.tsx` (submit carries `messages` and `input` is the new text only), `apps/tui/test/chat.test.tsx` (new: chat run shows the assistant text without `reply · assistant` header and without `✓ Done`; a failed chat run keeps the summary), `apps/tui/test/children.test.tsx` (new: a run `c1` with `parentRunId: 'r1'` appears in r1's tab as `→ hello-feature`, its events are subscribed; when it ends the fake receives a `submitRun` whose input starts with `[event]`; a child of a closed tab opens nothing), `apps/tui/test/home.test.tsx` (profile line `Node · npm test · 3 files` appears; `cwd === home` submits `project: <home>/.shibaox/workspace`)

- [ ] **Step 1: failing tests.**
- [ ] **Step 2: run (`cd apps/tui && bun test`), watch fail.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: run, watch pass**; `pnpm --filter @wizardingcode/shibaox-tui test-vitest lint`.
- [ ] **Step 5: commit** `feat(tui): the conversation is structured, chat runs read as messages, dispatched runs join the thread, the home shows the project profile`

---

### Task 8: Demo org, docs, end-to-end

- [ ] Update `~/shibaox-demo/org/roles/assistant.yaml` and `prompts/assistant.md` to the new template (the scaffold never overwrites; copy the two files).
- [ ] README: "The orchestrator" section (acts, dispatches, remembers; role fields `max_steps/max_turns/budget_usd`, `permissions.network`, capabilities `orchestrate`/`memory`), `GET /projects/profile`, `[event]` messages.
- [ ] Rebuild, restart the daemon (`shibaox daemon stop` then any CLI call), run the spec's verification list through the pty harness (`scratchpad/ptyrun.py`) and record results in the ledger.
- [ ] Commit `docs: the orchestrator, project profile and memory`.
