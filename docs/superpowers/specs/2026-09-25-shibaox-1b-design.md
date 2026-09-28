# shibaox — Fase 1B: fornecedores, runtimes reais, Jev e memória

Complementa `2026-09-25-shibaox-design.md` (spec base). Aprovado em 2026-09-25.

## Contexto

A fase 1A entregou o motor (event sourcing, scheduler com reentrada por ordem, gates, CLI) a correr com um adaptador mock. A fase 1B liga o motor a modelos reais em dois modos: **fornecedores diretos** (o shibaox fala com a API do modelo e corre o loop de agente) e **runtimes** (Claude Code e, mais tarde, Codex/Cursor). Traz também o Jev para decisões e gates, o router de `models.yaml`, e a memória (vault Obsidian + graphify).

Requisito adicionado pelo Andre: cobrir a lista completa de fornecedores (APIs diretas, gateways, inferência hospedada, locais) e, para a Anthropic, oferecer as duas vias: chave de API direta e subscrição via runtime Claude Code.

## Decisões

| Tema | Decisão |
|---|---|
| Base da camada de fornecedores | Vercel AI SDK 7 + catálogo próprio em YAML |
| Fornecedores só por OAuth/subscrição | Não implementamos OAuth; entram pelo runtime que já os tem (`via_runtime`) |
| Runtime direto | `DirectAdapter`: loop AI SDK com ferramentas mínimas restritas ao workspace |
| Ordem | 1B-1: fornecedores, runtime direto, Jev, router, endurecimento. 1B-2: Claude Code, memória, autorouting |

## Factos verificados (2026-09-25)

- `ai@7.0.116`; `@ai-sdk/openai-compatible@3.0.57` (`createOpenAICompatible({ name, baseURL, apiKey?, headers? })`); oficiais: `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/xai`, `@ai-sdk/azure`, `@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex`, `@ai-sdk/groq`, `@ai-sdk/mistral`, `@ai-sdk/cohere`, `@ai-sdk/deepseek`, `@ai-sdk/cerebras`, `@ai-sdk/deepinfra`, `@ai-sdk/fireworks`, `@ai-sdk/togetherai`, `@ai-sdk/moonshotai`, `@ai-sdk/alibaba`, `@ai-sdk/minimax`, `@ai-sdk/huggingface`, `@ai-sdk/perplexity`, `@ai-sdk/zai`; comunidade: `@openrouter/ai-sdk-provider@3.1.0`, `ai-sdk-ollama@4.3.0`. Saída estruturada: `generateText({ output: Output.object({ schema }) })`; tools: `tool({ description, inputSchema, execute })`; multi-step: `stopWhen: isStepCount(n)`.
- `@typesafe-ai/sdk@0.6.0`: `new TypeSafeClient({ apiKey?, baseUrl?, retries?, timeout? })`, `systemOne({ state, questions, model? })`, helpers `choice`, `score`, `noul`; respostas com `choice | score | value`, `probabilities`, `confidence`, `usage`. Modelo `jev-latest`, estado até 32k tokens.
- `@anthropic-ai/claude-agent-sdk@0.3.283`: `query({ prompt, options })` com `systemPrompt`, `model`, `cwd`, `allowedTools`, `disallowedTools`, `permissionMode`, `canUseTool`, `mcpServers` (stdio/http/sdk), `maxTurns`, `maxBudgetUsd`, `outputFormat: { type: 'json_schema', schema }`, `abortController`, `resume`/`forkSession`. Tools MCP chamam-se `mcp__<server>__<tool>`; `allowedTools: ['mcp__x__*']`.

## 1. Camada de fornecedores — `@wizardingcode/shibaox-providers`

### Catálogo `providers/catalog.yaml`

Uma entrada por fornecedor:

```yaml
- id: openrouter
  name: OpenRouter
  kind: openrouter            # openai-compatible | openai | anthropic | google | xai | azure | bedrock | vertex | groq | mistral | cohere | deepseek | cerebras | deepinfra | fireworks | togetherai | moonshotai | alibaba | minimax | huggingface | perplexity | zai | openrouter | ollama
  base_url: https://openrouter.ai/api/v1
  auth: { type: api_key, env: OPENROUTER_API_KEY }
  models: [anthropic/claude-sonnet-4.5, openai/gpt-5, meta-llama/llama-3.3-70b-instruct]
  pricing: { "anthropic/claude-sonnet-4.5": { input_per_m: 3, output_per_m: 15 } }
- id: ollama
  name: Ollama (local)
  kind: ollama
  base_url: http://localhost:11434
  auth: { type: none }
- id: lmstudio
  name: LM Studio (local)
  kind: openai-compatible
  base_url: http://localhost:1234/v1
  auth: { type: none }
- id: anthropic
  kind: anthropic
  auth: { type: api_key, env: ANTHROPIC_API_KEY }
- id: anthropic-subscription
  name: Anthropic (subscrição via Claude Code)
  via_runtime: claude-code
- id: openai-codex-subscription
  via_runtime: codex
```

`auth.type`: `api_key` (env var → Bearer/x-api-key conforme o `kind`), `none` (locais), `aws` (Bedrock: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` ou `AWS_BEARER_TOKEN_BEDROCK`), `gcp` (Vertex: `GOOGLE_VERTEX_PROJECT`, `GOOGLE_VERTEX_LOCATION`, ADC), `azure` (`AZURE_RESOURCE_NAME`, `AZURE_API_KEY`).

Cobertura da lista: APIs diretas (Anthropic, Google, OpenAI, xAI, Mistral, DeepSeek, Cohere, Moonshot/Kimi, Qwen/Alibaba Model Studio, MiniMax, Z.AI, StepFun, Xiaomi, Venice, Arcee, Synthetic, Vydra, GMI Cloud, Volcengine, Tencent Cloud, Qianfan, BytePlus, OpenCode/OpenCode Go), gateways (Bedrock, Bedrock Mantle, Anthropic Vertex, Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter, ClawRouter, LiteLLM, Microsoft Foundry, Kilocode), inferência (Groq, Cerebras, Together, Fireworks, NVIDIA, Hugging Face, DeepInfra, Chutes, Novita, Ollama Cloud), locais (Ollama, LM Studio). Tudo o que não tem pacote oficial entra como `openai-compatible` com `base_url`. O que só existe por OAuth entra com `via_runtime` (Claude Max → `claude-code`; ChatGPT/Codex → `codex`; Gemini CLI OAuth → `gemini-cli`; GitHub Copilot → `copilot-cli`; Qwen Portal → `qwen-code`; MiniMax/Z.AI/Kimi Coding Plan → `via_runtime` do respetivo CLI, ou API key quando o plano a expõe). Entradas de catálogo são dados; não exigem código novo.

### Interface

```ts
interface ProviderRegistry {
  list(): ProviderEntry[];
  get(id: string): ProviderEntry;
  model(ref: string): LanguageModel;          // ref = "<provider>/<model>" ou "<model>" com provider por defeito
  isConfigured(id: string): { ok: boolean; missing: string[] };
  estimateCost(ref: string, usage: { inputTokens: number; outputTokens: number }): number | undefined;
}
```

`LlmClient` sobre o AI SDK: `generate({ model, system, messages, tools?, output?, maxSteps? })` e `stream(...)` que devolvem `usage`, `cost` e, com `output`, o objeto validado.

### CLI

`shibaox providers list [--configured]`, `shibaox providers test <id> [--model <m>]` (uma geração curta real), `shibaox models` (resolução tier → modelo → fornecedor/runtime por papel, com o estado da configuração).

### Testes

Servidor fake OpenAI-compatible em processo (chat completions com e sem stream, tool calls) para testes de contrato; cada entrada do catálogo valida contra o schema; teste real por fornecedor só quando a env var existe (`describe.skipIf`).

## 2. Runtime direto — `DirectAdapter` (`@wizardingcode/shibaox-adapter-direct`)

Implementa `RuntimeAdapter`. Por tarefa: system prompt do papel + instrução + contexto (input, outputs anteriores, último relatório de gate), `streamText` com `stopWhen: isStepCount(maxSteps)` e ferramentas:

| Tool | Restrição |
|---|---|
| `list_files(glob)` | dentro do workspace |
| `read_file(path)` | dentro do workspace, tamanho máximo |
| `write_file(path, content)` | dentro do workspace; emite `file_changed` |
| `run_command(cmd)` | `runCommand` com timeout; bloqueia comandos fora da allowlist do papel (`tools:`) |
| `graph_query(question)` | 1B-2: consulta ao graphify |
| `finish(output)` | termina com o resultado tipado (schema do nó, se houver) |

Eventos: `started`, `text`, `tool_use`, `tool_result`, `file_changed`, `result` (com `usage` e custo estimado), `error`. Respeita `ExecutionContext.signal` (aborta o stream). Um modelo sem suporte a tools recebe um modo "só texto" que devolve `result` com o texto.

## 3. Jev — `@wizardingcode/shibaox-jev`

- `JevClient` sobre `@typesafe-ai/sdk`; `fanOut(state, questions)` numa chamada; `gateByConfidence(answer, threshold)` → `pass | escalate | fail`.
- `JevDecider implements Decider`: `choice` com as opções do nó e as instruções da pergunta; confiança abaixo do limiar → escala para o `LeadDecider` (LLM judge via providers) quando configurado.
- `jevCheckRunner`: checks `jev` (`noul` ou `score`) sobre o estado `{ spec, diff, output }`; devolve `CheckResult` com `confidence` e `cost`.
- Estado enviado ao Jev truncado a 32k tokens com prioridade spec > output > diff.

## 4. Router e judge — em `@wizardingcode/shibaox-core`

- `resolveModel(role, models: Models, registry, runtimes)` → `{ kind: 'direct', ref } | { kind: 'runtime', runtime, model }`. Ordem: override por papel → tier do papel → tiers de `models.yaml`. Se a entrada é `via_runtime`, usa esse runtime. Se o runtime preferido não suporta o modelo (por exemplo Claude Code com um modelo não Anthropic), escolhe `direct` e regista um aviso no run.
- `judgeCheckRunner`: rubrica + contexto → `Output.object({ passed, evidence, suggestion })` com o modelo do tier `strong`.
- `CheckResult.cost` e `GateReport.cost` somados ao `spentUsd`.

## 5. Adaptador Claude Code — `@wizardingcode/shibaox-adapter-claude-code` (1B-2)

`query()` com: `systemPrompt: { preset: 'default', append: <prompt do papel> }`, `model`, `cwd: <worktree>`, `allowedTools` derivados de `role.tools`, `disallowedTools` (`Bash(rm -rf *)`, push/deploy salvo `approval_required`), `permissionMode: 'default'`, `canUseTool` que consulta `approval_required` e pergunta ao `HumanHandler`, `maxBudgetUsd` = orçamento restante do run, `mcpServers` selecionados pelo autorouting (graphify em stdio; tools do shibaox em processo via `createSdkMcpServer`), `outputFormat` json_schema quando o nó define `output_schema`, `abortController` ligado ao `signal`, `settingSources: []` para não carregar CLAUDE.md nem plugins do utilizador. Mapeamento: `assistant.text` → `text`, `tool_use` → `tool_use`, `tool_result` → `tool_result`, `result` → `result` com `total_cost_usd` e `usage`. Worktree: `git worktree add .shibaox/worktrees/<runId> -b shibaox/<runId>`; removido no fim do run salvo `--keep-worktree`.

## 6. Memória (1B-2)

- **Vault writer**: `writeRunNote(vault, state, events)` → `10-projects/<proj>/runs/<date>-<runId>.md` com frontmatter (`type: run`, ids, status, custo, workflow) e wikilinks para `[[<proj>]]`, `[[<workflow>]]`, papéis e spec; `writeDecisionNote` para nós `decide` e `human`.
- **graphify**: `ensureGraphify()` (uv tool install), `buildGraph(project, vaultSubdir)`, `updateGraph`, `serveMcp(graphJson)` → config stdio para o Claude Code; `graphQuery(question)` via CLI para o DirectAdapter.
- **Autorouting v0**: pré-filtro determinístico do catálogo de capacidades + fan-out Jev (um `noul` por candidato, `choice` para equipa e workflow) com limiares 0.8/0.5.

## 7. Endurecimento herdado do 1A (1B-1)

- Cancelamento: `ExecutionContext.signal` passa a ser um `AbortSignal` real por run; `RuntimeAdapter.cancel(jobId)` é removido do contrato (o signal chega a todos os adaptadores).
- `CheckResult.cost` e `GateReport.cost`.
- `RunCreated.workflowSnapshot` (o workflow resolvido, com gates injetados) para que `resume` não dependa do YAML atual.
- Deteção de stall: com nada pronto e nós `pending`/`gate_failed` sem caminho de reentrada, o motor grava `RunCancelled { reason: 'stalled: ...' }` em vez de `RunCompleted`.
- `resume --budget` em `waiting_human` aplica o novo orçamento.

## Verificação da fase

- 1B-1: `shibaox providers test ollama` e `test openrouter` passam com as chaves presentes; `shibaox run hello-feature --adapter direct` completa contra o sample repo com um modelo real (Ollama local ou OpenRouter) e um gate `jev` real; reprovação forçada gera rework com relatório; `shibaox models` mostra a resolução correta para `anthropic` e `anthropic-subscription`.
- 1B-2: `shibaox run hello-feature --adapter claude-code` completa em worktree com nota no vault e `graphify-out/graph.json` atualizado; `graph_query` responde a partir do MCP.

## Fora de âmbito

Codex/Cursor/Gemini CLI adapters (fase 4), control plane, Electron, editor visual, aprendizagem do autorouting, fluxos OAuth próprios.
