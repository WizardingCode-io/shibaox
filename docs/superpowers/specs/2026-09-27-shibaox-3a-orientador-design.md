# shibaox 3A — o orientador: conversa real, agir, despachar, perfil do projeto, memória

Data: 2026-09-27. Base: `main` em `402d50d` (fase 2A-3 + rework "ink" integrados).

## Objetivo

O chat do painel passa a ser a entrada única do shibaox: falas com um **orientador** que
responde, **faz** (escreve ficheiros, corre comandos, lê a web) e, quando o pedido é obra,
**despacha** um workflow da org (uma equipa) e acompanha-o no mesmo fio. Ao abrir o painel
num projeto, o shibaox conhece o projeto (perfil) e lembra-se do que lhe disseram (memória do
utilizador e do projeto). Tudo isto com qualquer provider: `claude-code` (subscrição) ou
`direct` (API, OpenRouter, local).

Fora de âmbito (fases seguintes): rotinas 24 h e Telegram com texto (3B), catálogo de
equipas por stack (3C), equipas de outros domínios (3D), desktop.

## 1. Conversa real

- `SubmitRequest.messages?: ChatMessage[]`, `ChatMessage = { role: 'user' | 'assistant'; content: string }`.
  O daemon guarda `input: { spec: req.input, messages }` (só quando há mensagens). `graphFor`
  e o autorouting continuam a receber só `req.input`.
- O bloco do pedido no painel mostra só `input.spec` (o texto novo). O fio deixa de aninhar
  transcrições: `continueRun` envia `input = texto novo` e `messages = [pedido, resposta]` por
  run do fio (a resposta = texto de topo do nó, sem os de subagentes).
- Adapters: `direct` expande `messages` como mensagens `user`/`assistant` do AI SDK antes da
  mensagem final da tarefa; o `Input:` JSON não repete `messages`. `claude-code` recebe a
  conversa transcrita no prompt (`Conversation so far:` + `User:`/`Assistant:`) antes de
  `Task:`. Retomar sessões Claude Code entre runs fica para depois (sessão por cwd,
  callbacks de permissão por run: não testado; a transcrição é determinista).
- Runs de chat no painel (workflow marcado `conversation: true`): sem cabeçalho de nó,
  sem linha `■ done`, sem cartão-resumo quando termina bem (o resumo fica quando falha ou é
  cancelado); o texto do orientador é a resposta. O custo continua na sidebar.

## 2. O orientador age

- Papel `assistant` (template e demo): `model_tier: cheap`, `capabilities: [orchestrate, memory]`,
  `tools: [read, write, git, node, npm, pnpm, bun, python3]`,
  `permissions: { network: ['*'], approval_required: [push, deploy] }`, `max_steps: 40`,
  `max_turns: 80`.
- Prompt novo (`prompts/assistant.md`): responde na língua do utilizador; faz o que é pedido
  com as ferramentas; pedidos pequenos (um script, uma correção, uma resposta) faz já;
  obra maior (feature com testes, várias partes) despacha com `start_workflow` e diz o que
  lançou; explica em duas linhas o que fez; nunca diz "não implemento".
- Schema do papel: `max_steps?`, `max_turns?`, `budget_usd?` (inteiros positivos / número
  positivo). `direct` usa `max_steps` (senão 12); `claude-code` usa `max_turns` (senão 60);
  ambos limitam o orçamento do job a `min(budget_usd, restante)`.
- `direct` respeita `write`: `write_file` só existe quando `role.tools` inclui `write` (e o
  papel não é `read-only`); `run_command` continua pela allowlist de programas.
- Web: `permissions.network` é uma allowlist de hosts (`*` = todos; senão sufixo do
  hostname). `direct` ganha `web_fetch({ url })` (GET, 15 s, 200 kB, HTML reduzido a texto)
  quando a lista não está vazia. `claude-code` deixa de negar `WebFetch`/`WebSearch` quando
  a lista não está vazia; `canUseTool` verifica o host do `WebFetch` contra a lista e permite
  `WebSearch`.
- Fora de um projeto: se o painel abre no diretório home, o projeto passa a ser
  `~/.shibaox/workspace` (criado). Noutro diretório sem git corre `inplace` como hoje.

## 3. Perfil do projeto

- `profileProject(dir)` em `@shibaox/core` (`src/project/profile.ts`): nome, git, stack
  (frameworks/linguagens por marcadores: package.json deps, composer.json, pyproject/
  requirements, go.mod, Cargo.toml, pubspec.yaml, project.godot, *.csproj/Unity, Gemfile,
  Makefile), gestor de pacotes, comando de testes (`detectTestCommand`), contagem de ficheiros
  (ignora node_modules/.git/vendor/dist/build; para em 20 000), linguagens por extensão
  (top 5), e `summary` (`Laravel · PHP · PHPUnit · 412 files`).
- Daemon: `GET /projects/profile?path=…&org=…` calcula o perfil (cache 60 s por caminho),
  escreve `10-projects/<projeto>/profile.md` no vault da org (quando há vault) e devolve o
  perfil. Cliente: `projectProfile(path, orgRoot)`.
- Home: uma linha sob o prompt com o `summary` do projeto atual (ou nada quando a pasta é
  vazia/sem marcadores). Sugestão de equipa vem com o catálogo por stack (3C).

## 4. Despacho

- `RunCreated.parentRunId?` (schema, reducer, `RunState`, `RunSummaryPlus`), `SubmitRequest.parentRunId?`.
  O run filho herda org, projeto e adapter; o modo de workspace é o da org (worktree num
  repositório), não o do pai (o chat corre `inplace`). O turno que o painel submete quando um
  filho termina leva `event: true` e nunca recebe `start_workflow`.
- Ferramenta `start_workflow({ workflow, request })` para papéis com a capability
  `orchestrate`: submete um run do mesmo org/projeto/adapter com `parentRunId` = o run do
  orientador, e devolve `{ runId, workflow, status: 'queued' }` sem esperar. A descrição da
  ferramenta lista os workflows da org (nome e descrição), excluindo o do próprio run.
  Em `direct` é uma tool do AI SDK; em `claude-code` é um servidor MCP em processo
  (`createSdkMcpServer` do Agent SDK, exposto por `@shibaox/adapter-claude-code` como
  `sdkMcpServer(name, tools)`), permitido via `mcp__shibaox__*`.
- O daemon liga isto em `buildRuntime` através de `RuntimeOptions.orchestration?: { workflows, startWorkflow }`
  (o `RunManager` passa `submit`). O run filho herda `orgRoot`, `project`, `adapter`,
  `workspace` mode e o orçamento por run da org.
- Painel: um run com `parentRunId` pertence ao fio do pai (a tab que o contém); o poller
  anexa-o ao fio e subscreve-o quando o vê na lista. No fio aparece como um bloco de pedido
  marcado `→ <workflow>` seguido dos cartões normais (nós, gates, aprovações, diff). Quando
  um run filho termina, o painel continua a conversa com uma mensagem de evento
  (`[event] workflow hello-feature finished: completed · 3 nodes · files … · branch …`),
  mostrada como uma linha discreta (não como bolha do utilizador); o orientador responde a
  seguir. O prompt do orientador explica as mensagens `[event]`.

## 5. Memória

- `@shibaox/memory` ganha `MemoryNotes` sobre o vault: `remember(scope, text)` acrescenta
  `- <data> · <texto>` a `00-org/memory.md` (scope `user`) ou `10-projects/<p>/memory.md`
  (scope `project`); `recall(query)` devolve até 20 linhas que contêm todas as palavras da
  pergunta (sem distinguir maiúsculas), das duas notas; `preamble()` devolve as últimas 40
  linhas de cada nota (máx. 4 kB) mais o `summary` do perfil quando existe.
- Ferramentas `remember({ scope, text })` e `recall({ query })` para papéis com a capability
  `memory` (mesmo mecanismo de ligação que `start_workflow`).
- O preâmbulo (perfil + memória) entra no system prompt de todos os papéis do run via a
  opção `preamble(job)` dos dois adapters, montada pelo daemon em `buildRuntime`.

## Ficheiros

- `packages/schemas/src/{role,events}.ts`; `packages/core/src/{run/state,run/reducer,executors/types}.ts`,
  `packages/core/src/project/profile.ts` (novo);
- `packages/adapter-direct/src/{adapter,tools,web}.ts`; `packages/adapter-claude-code/src/{adapter,permissions,tools-map,mcp}.ts`;
- `packages/memory/src/notes.ts` (novo); `packages/daemon/src/{run-manager,runtime,server,client,templates}.ts`,
  `packages/daemon/src/runs/profile.ts` (novo);
- `apps/tui/src/context/{client,data,poller}.ts(x)`, `apps/tui/src/routes/session/{timeline,cards,request}.tsx`,
  `apps/tui/src/routes/home.tsx`, `apps/tui/src/model/stream.ts`, `apps/tui/src/testing/fake-client.ts`.

## Verificação

- `pnpm build && pnpm test && pnpm lint` verdes (vitest por pacote, `bun test` no painel).
- Contra o daemon real, na demo (`~/shibaox-demo`): "olá" responde; "faz um script em JS
  que faça scraping de uma página" escreve o ficheiro e o diff aparece; "adiciona um endpoint
  /health com testes" despacha `hello-feature` no mesmo fio, pede a aprovação do push e o
  orientador resume; a home mostra o perfil do projeto; `lembra-te que uso pnpm` seguido de
  "o que uso para pacotes?" responde a partir da memória.
