# shibaox — Sistema operativo de agentes sobre runtimes existentes

## Contexto

O Andre quer construir um "organismo vivo" de agentes que gere um negócio, de pequeno a grande. O sistema define equipas, papéis, workflows e gates de QA, e usa runtimes de coding agents já existentes (Claude Code, Codex, Cursor) como workers, sem reimplementar um agent loop. Para conter custos e latência, as decisões fechadas (rotear, classificar, pontuar, validar) vão para o **Jev** (TypeSafe, modelo System One) e só a geração de código e raciocínio longo vai para LLMs.

Produto para vender, com a WizardingCode como primeiro cliente. Tem de ser instalável por uma pessoa sozinha sem desistir. A pasta `~/AIProjects/shibaox` está vazia: projeto de raiz.

## Decisões tomadas no brainstorm

| Tema | Decisão |
|---|---|
| Propósito | Produto vendável; uso interno primeiro |
| Interceção do runtime | Orquestrador externo; runtimes lançados em headless como workers |
| Stack | TypeScript. Core como biblioteca pura. Casca desktop Electron (tray, notificações, subprocessos) |
| Workflows | Declarativos em YAML (fonte de verdade) + editor visual mais tarde |
| Grafo | Memória em grafo (graphify + Obsidian) e workflows como grafos de estados |
| Topologia | Local + control plane desde o MVP; modo solo com SQLite embutido |
| Motor | Próprio, event-sourced, runs como grafos de estados |
| Grafo em modo solo | graphify faz merge multi-projeto para `graph.json`; FalkorDB só no control plane |
| Primeira fatia | A base (motor, adaptadores, gates, router, memória). Equipas vêm depois |

## Factos verificados sobre dependências externas

**Jev / TypeSafe** (`pip install typesafe-sdk`, SDK JS também existe; endpoint `https://api.typesafe.ai/v1/systemone`, env `TYPESAFE_API_KEY`)
- Recebe `state` (texto/JSON, até 32k tokens) + perguntas tipadas: `Choice`, `Score`, `Noul`. Avalia em paralelo, ~150 ms, devolve probabilidades e confiança. Não gera texto nem código.
- Padrões oficiais: speculative fan-out, confidence-gated routing, composite scoring, intent routing. Cookbooks relevantes: guardrails, skill suggestion, entity alignment, citation check.
- Modelo `jev-1.13.0` (alias `jev-latest`), 64k contexto total, output grátis.

**Claude Code headless** (docs em https://code.claude.com/docs/en/headless.md)
- `--output-format stream-json` emite init, mensagens, `tool_use`, `tool_result`, `permission_denied`, `result` (custo, tokens, `session_id`).
- `--permission-prompt-tool <mcp-tool>` delega cada pedido de permissão a um MCP tool nosso.
- `--mcp-config`, `--plugin-dir`, `--agents` (JSON), `--system-prompt` / `--append-system-prompt`, `--model`, `--add-dir`, `--bare`, `--max-turns`, `--allowedTools`/`--disallowedTools`, `--json-schema`, `--resume`, `--fork-session`, `--input-format stream-json`.
- Hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `PermissionRequest`, etc.) com handlers `command`/`http`/`mcp_tool`; só por settings ou plugin, não por flag.
- Agent SDK `@anthropic-ai/claude-agent-sdk`: `query()` async iterable, `canUseTool`, hooks em processo, MCP em processo, `agents`, `maxBudgetUsd`, `resume`, abort. **Usar o SDK no adaptador Claude Code; subprocess só para runtimes sem SDK.**
- Codex CLI (`codex exec --json`, SDK TS) e Cursor (`agent -p`) não foram verificados em documentação oficial nesta sessão. Validar ao implementar cada adaptador; o design assume o mínimo comum: lançar, streamar eventos, cancelar.

**graphify** (`uv tool install graphifyy`; `graphify install --platform <claude|cursor|codex|...>`)
- Código por AST local, sem LLM. Docs/PDF/imagens por Gemini (`GEMINI_API_KEY`) ou pelo agente anfitrião.
- Saídas: `graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html`. Exports: Obsidian vault (wikilinks), wiki, GraphML, Cypher (Neo4j/FalkorDB).
- `graphify watch`, `graphify hook install` (post-commit/post-checkout), `--update` incremental, merge multi-path.
- MCP server: `python -m graphify.serve graphify-out/graph.json` (stdio ou http) com `query_graph`, `get_node`, `get_neighbors`, `shortest_path`, `list_prs`, `get_pr_impact`, `triage_prs`.

## Arquitetura

### 1. Modelo da organização (YAML no "org repo")

```
org/
  org.yaml            organização, orçamentos, lista de equipas
  models.yaml         providers, tiers, modelo por papel e por gate
  teams/<team>.yaml   lead, papéis, gates obrigatórios, workflows permitidos
  roles/<role>.yaml   capacidades, runtime preferido, tier, prompt, tools, permissões
  workflows/<wf>.yaml grafo de nós
  gates/<gate>.yaml   lista ordenada de checks
  catalog/            entradas de capacidades (skills, plugins, MCPs, tools)
  prompts/            system prompts dos papéis
```

Um papel é um perfil; cada run instancia papéis com contexto próprio. O `lead` de uma equipa aprova, rejeita e redistribui. Permissões por papel: `fs` (workspace apenas), `network`, `approval_required` (push, deploy).

### 2. Workflows como grafos de estados

Tipos de nó: `task` (papel + runtime), `decide` (Jev Choice ou lead), `gate`, `human`, `code`, `parallel`/`join`. Gates obrigatórios da equipa são injetados automaticamente antes de nós terminais.

Run = instância do grafo. Estado derivado do event log: `RunCreated`, `NodeStarted`, `NodeCompleted`, `NodeFailed`, `GatePassed`, `GateFailed`, `HumanRequested`, `HumanResponded`, `BudgetWarning`, `BudgetExceeded`, `RunCompleted`, `RunCancelled`. Eventos imutáveis, append-only, replay determinístico.

Isolamento: um git worktree por run e por ramo de `parallel`. Integração via merge queue por projeto (rebase, gates de novo, aprovação humana, conflitos resolvidos por um nó `task`). `claims` opcionais por workflow para sinalizar sobreposição de áreas.

### 3. Executores

```ts
interface RuntimeAdapter {
  id: string;                       // 'claude-code' | 'codex' | 'cursor' | 'generic-cli'
  capabilities(): Capability[];
  run(job: TaskJob, ctx: ExecutionContext): AsyncIterable<RuntimeEvent>;
  cancel(jobId: string): Promise<void>;
}
```

Executores não-runtime: `jev` (perguntas tipadas), `code` (scripts/testes), `llm-direct` (chamada API curta). O runtime nunca conhece o workflow: recebe tarefa, devolve resultado tipado (`--json-schema`).

### 4. Router de modelos e custos

Ordem: decisão fechada → Jev; geração curta → `llm-direct` barato; código/raciocínio → runtime com modelo forte; confiança baixa do Jev escala para o nível seguinte. Orçamentos em três níveis (org, equipa, run). 80% → notificação; 100% → run pausa em `BudgetExceeded`.

### 5. Gates de QA

Checks tipados: `code` (primeiro, barato), `jev` (uma única chamada com todos os Nouls/Scores sobre diff + spec + output), `judge` (modelo forte, só se confiança baixa ou obrigatório), `human`. Reprovação devolve relatório estruturado injetado no nó de rework.

### 6. Memória: Obsidian + graphify

**Vault Obsidian por organização** (camada humana):
```
vault/
  00-org/  10-projects/<proj>/  20-clients/  30-knowledge/  90-system/
```
O sistema escreve notas markdown com frontmatter (runs, decisões, relatórios de gate, custos) e wikilinks. O humano edita no Obsidian.

**graphify por projeto** (camada máquina): indexa código (`--watch`, hooks git) + subpasta do vault do projeto. MCP server servido aos agentes. Modo solo: merge multi-projeto para um `graph.json` da organização. Modo ligado: export Cypher para FalkorDB no control plane. Extração semântica do vault usa o tier `cheap`.

### 7. Autorouting e carregamento progressivo

1. Catálogo de capacidades (equipa, workflow, skill, plugin, MCP, tool) com descrição de uma linha.
2. Pré-filtro determinístico (projeto, equipa, tipos de ficheiro) → candidatos.
3. Jev speculative fan-out: um Noul por candidato + Choice equipa + Choice workflow, numa chamada.
4. Thresholds: ≥0.8 anexa; 0.5–0.8 pergunta ao lead só sobre os ambíguos; <0.5 descarta.
5. Injeção mínima na invocação: `--mcp-config` só com MCPs escolhidos, `--plugin-dir` com plugin gerado por run só com as skills escolhidas, `--agents` só do papel, `--bare`.
6. Registo das seleções; reprovações de gate por capacidade em falta ajustam pesos futuros.

### 8. Escolha de modelos por agente

`models.yaml` com `providers`, `tiers` (strong/cheap/local/decision), `roles.<role>.model|runtime`, `gates.<gate>`. UI: tabela com dropdown por papel e custo estimado. Router lê o ficheiro em cada despacho; se o runtime preferido não suporta o modelo, escolhe outro compatível e avisa.

### 9. Instalação para uma pessoa

Assistente na app desktop: (1) verificar/instalar Node, uv, git, graphify; (2) detetar runtimes `claude`/`codex`/`cursor`; (3) chaves (LLM obrigatória, Jev opcional); (4) vault existente ou novo; (5) primeiro projeto + graphify em background; (6) template de equipa "engineering". Nunca escreve YAML. Modo solo por defeito; "ligar a control plane" nas definições.

### 10. Control plane, daemon, observabilidade

- Control plane: Node + Postgres + FalkorDB. API, event store, fila de jobs, catálogo, org repo, dashboard. `docker compose up` ou hospedado.
- Daemon (Electron, tray): autentica, anuncia capacidades da máquina, executa jobs em worktrees, notificações, responde a `--permission-prompt-tool`.
- Modo solo: mesmo core com adaptador de persistência SQLite. Migração para o servidor ao ligar.
- Observabilidade: timeline por run, custos, decisões de gate, raciocínio Jev, replay a partir do event log.

## Estrutura do repositório (monorepo pnpm + turborepo)

```
shibaox/
  packages/
    core/            motor: modelos, event store, grafo de run, scheduler, router, gates, catálogo
    adapters/
      claude-code/   via @anthropic-ai/claude-agent-sdk
      codex/         via SDK/CLI (validar)
      cursor/        via CLI (validar)
      generic-cli/
    jev/             cliente TypeSafe + helpers de fan-out e thresholds
    memory/          vault writer (markdown+frontmatter), graphify runner, MCP client
    persistence/
      sqlite/        modo solo
      postgres/      control plane
    schemas/         zod + JSON Schema dos YAML e dos eventos
  apps/
    cli/             `shibaox run <workflow>`, `shibaox init`, `shibaox doctor`
    control-plane/   API + event store + fila + dashboard
    desktop/         Electron: tray, notificações, onboarding, permissões
  templates/
    teams/engineering/  primeira equipa (fase 4)
  docs/superpowers/specs/  specs de design (esta incluída)
```

## Fases

1. **Base (esta fase).** `packages/core`, `schemas`, `jev`, `persistence/sqlite`, `adapters/claude-code`, `memory` (vault writer + graphify runner + MCP), `apps/cli`. Um workflow de exemplo corre fim a fim em modo solo: task → gate (code + jev) → decide → human (aprovação no terminal).
2. **Control plane + daemon.** `apps/control-plane`, `persistence/postgres`, FalkorDB, protocolo daemon↔servidor, merge queue.
3. **Desktop + onboarding.** Electron, tray, notificações, `--permission-prompt-tool`, assistente de instalação, UI de modelos.
4. **Equipas.** Template engineering completo, depois gestão (port do wzrdxOS), editor visual de workflows, adaptadores Codex/Cursor.

## Plano de implementação da fase 1

Ordem pensada para ter algo a correr cedo e testar por camadas.

1. **Bootstrap do monorepo.** pnpm workspaces, turborepo, TypeScript strict, vitest, biome. `packages/schemas` com zod para `org.yaml`, `team`, `role`, `workflow`, `gate`, `models.yaml`, catálogo e eventos. Loader que valida e devolve tipos.
2. **Event store + run engine** (`packages/core`). Interface `EventStore` (append, readStream, subscribe); implementação SQLite em `persistence/sqlite`. Reducer puro `reduce(events) → RunState`. Scheduler que, dado `RunState` e o grafo do workflow, calcula os próximos nós prontos. Testes de replay determinístico e de `parallel`/`join`.
3. **Executores.** Interface `RuntimeAdapter` e `Executor`. Executor `code` (spawn com timeout, captura stdout/exit code). Executor `mock` para testes. Injeção automática de gates obrigatórios da equipa.
4. **Cliente Jev** (`packages/jev`). Wrapper tipado sobre o endpoint `/v1/systemone` (SDK JS se cobrir, senão fetch). Helpers: `fanOut(state, questions)`, `gateByConfidence(answer, thresholds)`. Executor `jev` para nós `decide` e checks `jev` de gates. Testes com respostas gravadas.
5. **Gates.** Motor de gate: corre checks por ordem, agrega, produz relatório estruturado; reprovação encaminha para `on_fail` com o relatório no contexto.
6. **Adaptador Claude Code** (`adapters/claude-code`). `query()` do Agent SDK com `systemPrompt` do papel, `model` do router, `allowedTools` das permissões, `maxBudgetUsd`, `mcpServers` selecionados, `canUseTool` que aplica `approval_required` e, em CLI, pergunta no terminal. Mapear mensagens SDK → `RuntimeEvent` → eventos do run. Worktree por run com `git worktree add`.
7. **Router de modelos e custos.** Leitura de `models.yaml`, resolução tier→modelo→runtime, contabilização de custo por `NodeCompleted`, `BudgetWarning`/`BudgetExceeded`.
8. **Memória.** `memory/vault`: escrever nota de run com frontmatter e wikilinks na estrutura do vault. `memory/graphify`: garantir instalação (`uv tool install graphifyy`), correr `graphify` no projeto e na subpasta do vault, arrancar o MCP server e passar a config ao adaptador. Autorouting v0: pré-filtro + fan-out Jev sobre o catálogo, com thresholds; sem aprendizagem ainda.
9. **CLI** (`apps/cli`). `shibaox init` (cria org repo mínimo e vault), `shibaox doctor` (verifica node, uv, git, graphify, runtimes, chaves), `shibaox run <workflow> --project <path> --input "<spec>"`, `shibaox runs`, `shibaox replay <runId>`.
10. **Workflow de exemplo** `templates/examples/hello-feature.yaml`: analyst (task) → implement (task backend) → qa (gate: `pnpm test` + Noul "cumpre a spec") → judge (decide Jev) → ship (human no terminal). Corre contra um repo de exemplo pequeno em `examples/sample-repo`.

## Verificação da fase 1

- `pnpm test` verde em todos os pacotes: reducer, scheduler (incl. parallel/join), gate engine, router, loaders de schema.
- Teste de integração com executor `mock`: o workflow de exemplo percorre todos os nós e o replay do event log reproduz o mesmo `RunState`.
- Execução real: `shibaox doctor` passa; `shibaox run hello-feature --project examples/sample-repo --input "adicionar endpoint /health"` com `ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY` reais termina em `ship`, com nota escrita no vault, `graphify-out/graph.json` atualizado e custo registado.
- Reprovação forçada: partir um teste no sample repo e confirmar que o gate reprova, o relatório entra no rework e a segunda tentativa passa.
- Orçamento: correr com `--budget 0.01` e confirmar pausa em `BudgetExceeded` sem perda de estado.

## Fora de âmbito da fase 1

Electron, control plane em Postgres/FalkorDB, adaptadores Codex/Cursor, editor visual, equipas completas, aprendizagem do autorouting, merge queue multi-run.
