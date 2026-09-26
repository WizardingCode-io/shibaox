# shibaox — Fase 2A-2: painel interativo de terminal (Ink)

Complementa `2026-09-26-shibaox-2a-daemon-design.md` (API do daemon) e a spec base. Brainstorm em 2026-09-26.

## Contexto

A fase 2A pôs o daemon a executar os runs e o CLI a falar com ele por comandos de linha (`runs`, `follow`, `inbox`, `approve`). Para uma pessoa a acompanhar vários runs ao mesmo tempo isso é pouco: quer ver a lista, o que cada agente está a fazer, e responder ao que espera por ela sem copiar ids. A fase 2A-2 entrega um painel interativo no terminal, cliente puro da API do daemon, com a voz e as cores do design system do Shibaox (`~/Projects/shibaox/design-system`), e passa `run`/`follow` a usar o mesmo renderizador do stream.

Referências a igualar: a interface do próprio Claude Code (Ink) e os painéis de runs do OpenClaw/Hermes; o shibaox diferencia-se por mostrar equipas, gates e aprovações, não uma conversa.

## Decisões

| Tema | Decisão |
|---|---|
| Tecnologia | Ink 7 + React 19 em `apps/tui` (`@shibaox/tui`); `ink-testing-library` nos testes |
| Dados | Cliente puro do daemon: sondagem de `listRuns`/`inbox` a 1 s + SSE do run selecionado; sem alterações ao daemon |
| Âmbito | Painel completo (lista, detalhe com stream, inbox com aprovar/negar) **e** formulário de novo run |
| Layout | Dois painéis (runs à esquerda, detalhe à direita) com faixa do inbox no topo; colapsa abaixo de 100 colunas |
| Arranque | `shibaox` sem argumentos ou `shibaox ui`; `run`/`follow` com TTY usam o `StreamView` |
| Tema | Tokens do tema dark reduzidos a ANSI 256; estado nunca só por cor; sem emoji; `SHIBAOX_NO_MOTION=1` |
| Fora | Feed global de eventos no daemon (fase 3), edição de `models.yaml`/agendamentos no painel, rato, tema claro, Electron |

## 1. Pacote e arranque

- `apps/tui/src/`: `index.ts` (exporta `renderDashboard`, `renderStream`), `store.ts` (`AppStore`), `poll.ts` (sondagens e subscrição SSE), `theme.ts`, `keys.ts`, `components/` (`TitleBar`, `InboxBanner`, `RunList`, `RunDetail`, `StreamView`, `ToolCallLine`, `AgentStatus`, `NewRunForm`, `Help`, `Toast`), `screens/Dashboard.tsx`, `prefs.ts` (`~/.shibaox/ui.json`).
- `apps/cli` depende de `@shibaox/tui`. `shibaox` sem subcomando e `shibaox ui` → `connect()` (auto-arranque como hoje) → `renderDashboard(client, { version })`. Sem TTY: "The dashboard needs an interactive terminal. Try: shibaox runs" e exit 1.
- `shibaox run` (sem `--detach`, sem `--json`, com TTY) e `shibaox follow` (idem) renderizam o stream com `renderStream(client, runId, { onAnswer })`; o prompt de aprovação é o mesmo widget do painel. Sem TTY ou com `--json` mantêm o texto atual.
- Interfaces:

```ts
export function renderDashboard(client: DaemonClientLike, opts: { version: string; env?: NodeJS.ProcessEnv }): Promise<number>; // resolve com o exit code ao sair
export function renderStream(client: DaemonClientLike, runId: string, opts: { since?: string; signal?: AbortSignal }): Promise<number>;
/** O subconjunto do DaemonClient que a TUI usa; um fake implementa-o nos testes. */
export interface DaemonClientLike {
  health(): Promise<Health>;
  listRuns(q?): Promise<RunSummaryPlus[]>; getRun(id): Promise<RunState>;
  events(id, o?): AsyncIterable<Envelope>;
  inbox(): Promise<InboxItem[]>; answer(id, a): Promise<{ runId: string }>;
  cancel(id): Promise<RunState>; resume(id, o?): Promise<RunState>;
  submitRun(req: SubmitRequest): Promise<{ runId: string; warnings: string[] }>;
}
```

## 2. Dados: `AppStore` e `poll`

- `AppStore` guarda `{ health, runs, inbox, selectedRunId, runStates: Map<runId, RunState>, streams: Map<runId, StreamLine[]>, toast, daemonReachable, filter: 'active' | 'all', view: 'dashboard' | 'newRun' | 'help' | 'inboxList' }` com `subscribe(listener)` e ações puras (`select`, `setRuns`, `pushFrame`, ...). Sem Redux.
- `poll.start(client, store)`: `listRuns` + `inbox` a cada 1 s (500 ms nos 3 s a seguir a uma ação); `health` a cada 5 s. Falha → `daemonReachable=false`, próximo intervalo 5 s; sucesso → volta a 1 s.
- Subscrição SSE do run selecionado: uma de cada vez; ao mudar de seleção aborta a anterior. Frames `run` → `getRun` no `end` e em `NodeStarted/NodeCompleted/NodeFailed/GatePassed/GateFailed/HumanRequested/ToolApprovalRequested/NodeSuspended/BudgetExceeded`; frames `runtime` → `StreamLine` (texto, tool call aberta, tool call fechada por id com duração, sessão). Limite 2000 linhas por run (as mais antigas caem).
- `StreamLine`: `{ kind: 'text' | 'tool' | 'session' | 'event'; nodeId; depth: 0 | 1; text; tool?: { id, name, summary, status: 'running' | 'done' | 'error' | 'approval', durationMs? } }`. Um `tool_result` com `{ error }` marca `error`; um `ToolApprovalRequested` do mesmo nó marca a última tool `Bash` como `approval`.
- Ações: `answer(id, approved, note?)`, `cancel(runId)`, `resume(runId, budget?)`, `submit(req)` chamam o cliente, mostram um toast em sucesso ou erro (mensagem do daemon, 5 s) e forçam uma sondagem imediata.

## 3. Ecrãs e teclas

- **Barra de título:** `shibaox · daemon <versão> · <n> running · <n> queued`; quando inacessível: `Daemon unreachable, retrying…` em `danger`.
- **Faixa do inbox** (só com pedidos): `▲ Needs you (n): <comando ou prompt> · run <id8> · <nó> · <papel>   [a]pprove [d]eny [n]ote [i]nbox`. Com mais de um pedido, `i` abre a lista completa (seleção com `j/k`, `a`/`d` no selecionado).
- **Lista de runs** (22 colunas): id curto + workflow numa linha, `AgentStatus` na seguinte: `● Working` (info), `● Needs you` (warning), `○ Queued` (ink-muted), `✓ Done` (matcha), `✗ Failed` (danger), `‖ Paused` (warning), `— Cancelled` (ink-muted). Ordenação: ativos primeiro, depois por `updatedAt` desc. `f` alterna `active`/`all` (por defeito `active` = não terminais + terminais das últimas 24 h).
- **Detalhe:** cabeçalho `id8 workflow · estado · $custo · worktree?`; linhas dos nós do snapshot do workflow (`nome  estado  attempts=n  choice/erro`); separador; stream do run com auto-scroll (desligado ao subir com `↑`, religado no fim). `ToolCallLine`: `> nome resumo …  40 ms` com estado por palavra e cor; `approval` mostra `needs approval`; `running` mostra `Wave` (`▁▃▅` a rodar) ou `…` com `SHIBAOX_NO_MOTION`. Subagentes (`parentToolUseId`) com indentação extra.
- **Formulário de novo run** (`N`): campos org, project, workflow (lista do `loadOrg`, atualizada quando org muda), input, adapter (`mock`, `direct`, `claude-code`; defeito `adapter:` do org.yaml ou `mock`), workspace (`auto`, `inplace`, `worktree`), budget (opcional). `tab`/`shift+tab` navegam, `enter` submete, `esc` cancela. Defeitos: org `./org` se existir senão último usado; project `.`; restantes do último uso (`~/.shibaox/ui.json`: `{ lastOrg, lastProject, lastAdapter, lastWorkspace }`). Erro do daemon ou do `loadOrg` no rodapé do formulário.
- **Teclas globais:** `j/k` ou `↑/↓` na lista; `enter` foca o detalhe; `tab` alterna painel (e é a única navegação abaixo de 100 colunas); `c` cancela o run selecionado após `y`; `r` retoma (pede orçamento numa linha quando `paused_budget`); `N` novo run; `?` ajuda; `q` ou `esc` sai (o daemon continua). Confirmações e inputs de uma linha usam o mesmo componente `Prompt`.
- **Copy:** sentence case, verbo-primeiro, sem emoji; palavras de estado do design system (Working, Needs you, Done, Failed, Queued, Paused).

## 4. Tema

`theme.ts` mapeia tokens do tema dark para cores Ink (`color`/`backgroundColor` com hex, que o Ink reduz conforme o terminal): `shiba-strong #ffa15c` seleção e foco; `matcha #6acb8e` sucesso; `info #86aef5` a correr; `warning #f2c150` precisa de atenção; `danger #ff7a8a` erro; `ink-muted #b9a694` metadados; texto normal sem cor. Terminais sem truecolor recebem a aproximação do Ink. Estado nunca é só cor: sempre com palavra ou símbolo.

## 5. Erros e limites

| Situação | Comportamento |
|---|---|
| Daemon não arranca | mensagem do `connect` com o caminho do log, exit 1 |
| Daemon cai a meio | faixa `Daemon unreachable, retrying…`, ações desativadas, sondagem a 5 s; ao voltar retoma a 1 s e reabre a subscrição |
| 409 numa resposta | toast `Already answered elsewhere`; item sai na próxima sondagem |
| 404 num run selecionado | seleção salta para o primeiro da lista |
| Org inválido no formulário | erro do `loadOrg` junto ao campo org |
| Terminal < 60×15 | ecrã só com `Terminal too small (need 60×15)` |
| Sem TTY | `shibaox` recusa com a sugestão `shibaox runs`; `run`/`follow` ficam em texto |

Limites: 2000 linhas de stream por run; uma subscrição SSE; `--json` continua a ser texto puro (a TUI nunca escreve com `--json`).

## 6. Testes

`apps/tui/test` com `ink-testing-library` e `FakeDaemonClient` (em memória: runs, estados, inbox, frames SSE injetáveis, gravação de chamadas):
- Dashboard: estados renderizam com palavra e símbolo; `j/k` mudam seleção e abrem `events` do run certo (a anterior é abortada); faixa do inbox aparece e `a`/`d` chamam `answer` com o id; `c` pede `y`; `f` filtra; `q` desmonta sem timers vivos.
- Detalhe: `run` frames atualizam os nós; `tool_use` + `tool_result` colapsam numa linha com duração; `{error}` marca erro; `ToolApprovalRequested` marca `needs approval`; subagentes indentados; auto-scroll.
- Formulário: `N` abre, workflows lidos de um org temporário, `enter` chama `submitRun` com os campos, erro visível, `ui.json` guarda os últimos valores.
- Resiliência: cliente a falhar → faixa e backoff → recuperação; 409 → toast.
- `renderStream`: linhas iguais às do `follow` de texto, mais o prompt de aprovação que chama `answer`.
- CLI: `shibaox` sem TTY → mensagem e exit 1 (o teste do CLI já corre sem TTY); `run`/`follow` sem TTY inalterados (testes existentes).
- Higiene: `afterEach` limpa temporários e verifica que não ficam timers.

## 7. Verificação

- `pnpm test` verde incluindo `apps/tui`.
- Manual: `shibaox daemon start --detach`; `shibaox` abre o painel; `N` lança `hello-feature` com mock; o run aparece, o stream corre, a faixa do inbox pede o `ship`, `a` aprova, o run fica `Done`; `q` sai e `shibaox runs` mostra o run. Com `--adapter claude-code` (subscrição): as chamadas de ferramenta aparecem com duração e o push pede aprovação na faixa.
