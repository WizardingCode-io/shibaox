# shibaox — Fase 2A: daemon local, aprovações persistentes, canais e agendamentos

Complementa `2026-09-25-shibaox-design.md` (spec base, §10) e `2026-09-25-shibaox-1b-design.md`. Brainstorm em 2026-09-26.

## Contexto

As fases 1A a 1B-2 entregaram o motor event-sourced, os fornecedores diretos, o adaptador Claude Code, worktrees por run, memória (vault + graphify) e autorouting v0, tudo a correr dentro do processo do CLI. Duas lacunas impedem uso real: fechar o terminal mata o run, e um pedido de aprovação (push, deploy) dentro de uma task Claude Code falha o run quando ninguém está ao terminal.

A fase 2A introduz o **daemon local**: um processo por utilizador, sempre ligado, que executa os runs, guarda o estado, mantém o inbox de aprovações e fala com o utilizador por notificações nativas e Telegram. O CLI passa a cliente. A API local do daemon é o contrato que a interface Ink (2A-2), o servidor central (2C) e a app Electron (fase 3) vão reutilizar.

Critério de design transversal, fixado pelo Andre: cada peça tem de servir uma pessoa sozinha no portátil e escalar para uma multinacional sem mudar de arquitetura. Referências a igualar ou superar: OpenClaw (gateway sempre ligado, canais de mensagens) e Hermes Agent (daemon, cron, skills auto-escritas, memória episódica). O shibaox diferencia-se por orquestrar runtimes de código com equipas, papéis, workflows, gates Jev, replay determinístico, worktrees e pushes só com aprovação.

## Decisões

| Tema | Decisão |
|---|---|
| Ordem da fase 2 | 2A daemon; 2A-2 interface Ink; 2B swarm + merge queue; 2C servidor central; 2D loop de aprendizagem |
| Quem executa | O daemon executa os runs; o CLI é cliente. Fechar o terminal não mata nada |
| Transporte | HTTP JSON + SSE sobre socket Unix `~/.shibaox/daemon.sock` (0600), sem autenticação |
| Aprovação dentro de uma task | A sessão Claude Code fica bloqueada no `canUseTool` até à resposta; se cair (restart, timeout 2h), é retomada por `session_id` depois da resposta |
| Estado | Um SQLite por utilizador em `~/.shibaox/events.db`, só o daemon escreve |
| Canais | `Channel` plugável; 2A entrega notificação macOS e Telegram |
| Agendamentos | Cron no daemon, persistido, submete runs |
| Interface interativa | Fica para 2A-2 (Ink); nesta fase todos os comandos ganham `--json` |
| Dependências novas | Só `croner` (cron) e nada mais: HTTP com `node:http`, SSE à mão, Telegram por `fetch` |

## 1. Processos e ficheiros

- Pacote novo `packages/daemon` (`@wizardingcode/shibaox-daemon`) com `server/` (API, fila, retoma), `client/` (cliente `fetch` sobre socket, exportado como `@wizardingcode/shibaox-daemon/client`), `channels/`, `schedules/`.
- Diretório `SHIBAOX_HOME` (por defeito `~/.shibaox/`): `daemon.sock`, `daemon.pid`, `daemon.log`, `daemon.yaml`, `events.db`.
- `shibaox daemon start` corre em foreground; `--detach` faz `spawn` destacado, escreve o pid e devolve. `stop` envia `POST /shutdown` (termina runs com `cancel` só se `--force`; por defeito espera que os ativos terminem, até 60 s, depois aborta). `status` mostra versão, uptime, runs ativos e por estado, canais ligados.
- Auto-arranque: qualquer comando do CLI que precise do daemon e não o encontre arranca-o em `--detach`, espera pelo `GET /health` (até 5 s) e avisa numa linha ("Started the shibaox daemon (log: ~/.shibaox/daemon.log)"). Socket órfão (ficheiro existe, ligação recusada, pid morto) é removido antes de arrancar.
- launchd/systemd ficam para a fase 3.

`daemon.yaml` (todas as chaves opcionais):

```yaml
max_concurrent_runs: 4        # global; org.yaml pode ter o seu, menor
approval_timeout_minutes: 120 # sessão bloqueada além disto é suspensa
channels:
  macos: { enabled: true }
  telegram: { bot_token_env: SHIBAOX_TELEGRAM_TOKEN, chat_id: 123456789 }
```

## 2. Estado

- `SqliteEventStore` passa a viver em `~/.shibaox/events.db` (override `--db` só para `replay` offline). A base é única para todas as orgs e projetos do utilizador.
- `RunCreated` ganha `orgRoot` (obrigatório nos runs novos; opcional no schema para replays antigos), ao lado de `project`, `branch`, `adapter`, `workspaceMode`.
- Tabelas próprias do daemon, na mesma base: `schedules` (id, cron, org_root, project, workflow, input, adapter, budget_usd, enabled, last_run_id, created_at) e `channel_outbox` (notificações pendentes com tentativas e próximo envio). Aprovações não têm tabela: são eventos (secção 4) e o inbox deriva do estado.
- `EventStore` ganha `subscribe(runId | '*', listener)` para alimentar o SSE; a implementação SQLite emite em processo depois do `append`.

## 3. API local

Todos os pedidos e respostas em JSON; erros como `{ error: { code, message } }` com códigos HTTP 400/404/409/500.

| Método e caminho | Função |
|---|---|
| `GET /health` | `{ version, uptimeSeconds, runs: { running, queued, waiting }, channels: [...] }` |
| `POST /runs` | corpo `{ orgRoot, project, workflow, input, adapter?, workspace?, budgetUsd? }` → `{ runId }`; 400 se o org, workflow ou papéis não resolvem (mesmas validações do `buildRuntime` de hoje, antes de qualquer evento) |
| `GET /runs?status=&org=` | lista resumida (`RunSummary` + `status`, `project`, `workflow`, custo) |
| `GET /runs/:id` | `RunState` completo |
| `GET /runs/:id/events` | SSE; `Last-Event-ID` retoma a partir do índice; cada evento é `RunEvent` ou `RuntimeEvent` envelopado (secção 7) |
| `POST /runs/:id/cancel` | `RunCancelled` |
| `POST /runs/:id/resume` | corpo `{ budgetUsd? }`; 409 se o run não está retomável |
| `GET /inbox` | pedidos pendentes: nós `human` (`HumanRequested` sem resposta) e aprovações (`ToolApprovalRequested` sem `Resolved`), ordenados por data |
| `POST /inbox/:id` | corpo `{ approved: boolean, note? }` → 200, 404 se não existe, 409 se já resolvido |
| `GET /schedules`, `POST /schedules`, `DELETE /schedules/:id`, `POST /schedules/:id/run` | agendamentos |
| `POST /shutdown` | corpo `{ force?: boolean }` |

`id` de inbox: `human:<runId>:<nodeId>` ou `approval:<approvalId>`.

Cliente (`@wizardingcode/shibaox-daemon/client`): `DaemonClient { health(), submitRun(req), listRuns(q), getRun(id), events(id, { since? }): AsyncIterable<Envelope>, cancel(id), resume(id, o), inbox(), answer(id, a), schedules(), addSchedule(s), removeSchedule(id), shutdown(o) }`, construído com o caminho do socket; `ensureDaemon()` faz o auto-arranque.

## 4. Aprovações e sessões Claude Code

### Dois tipos de pedido

- **Nó `human`** (já existe). O `HumanHandler` do daemon devolve `deferred`, o run fica `waiting_human`; a resposta no inbox emite `HumanResponded` e o daemon chama `engine.resume`.
- **Aprovação de ferramenta** (novo). O `canUseTool` do adaptador Claude Code, ao classificar `push` ou `deploy` para um papel com `approval_required`, chama `approvals.request(req)` (interface `ApprovalHandler`, nova opção do adaptador, ao lado de `human`). O daemon emite `ToolApprovalRequested { approvalId, runId, nodeId, role, tool: 'Bash', program, category, command, argvHash }`, marca o run `waiting_approval` e devolve uma promessa. O `canUseTool` fica bloqueado nela. A resposta emite `ToolApprovalResolved { approvalId, approved, note, via }` (`via`: `cli` | `telegram` | `api`), o run volta a `running`, e a promessa resolve em `allow`/`deny` (com a nota como razão do deny).
- Uma aprovação aplica-se ao comando exato (`argvHash` = SHA-256 do argv normalizado) no nó em causa. O `canUseTool` consulta primeiro as `ToolApprovalResolved` do nó com o mesmo `argvHash`: já aprovado, permite sem perguntar; já negado, nega sem perguntar.

### Sessão que cai

- **Timeout**: `approval_timeout_minutes` (por defeito 120). Ao expirar, o adaptador aborta a query com erro de razão `approval_pending` (novo `AdapterErrorReason`). O pedido continua pendente no inbox.
- **Restart do daemon**: ao arrancar, os runs `waiting_approval` sem processo vivo são tratados como suspensos.
- Em ambos os casos o motor mapeia `approval_pending` para `NodeSuspended { nodeId, sessionId?, approvalId }` em vez de `NodeFailed`: o nó volta a `pending`, o run fica `waiting_approval` (mesmo padrão de `budget_exceeded` → `BudgetExceeded`).
- `SessionStarted { nodeId, runtime: 'claude-code', sessionId }` é emitido a partir do `system/init` em todos os runs Claude Code (também os que não suspendem). O reducer guarda `sessionId` por nó.
- Ao resolver o pedido de um run suspenso, o daemon chama `engine.resume`; o adaptador recebe `job.resumeSessionId` e `job.resumeNote` e chama `query({ prompt: resumeNote, options: { resume: sessionId, ... } })`, com o prompt: "The approval for `<command>` was granted/denied[: note]. Continue the task." Sem `sessionId` (adaptador direto, ou init nunca chegou), o nó reinicia do zero com o `instruction` original mais a mesma nota.
- Aprovações resolvidas de um nó que reinicia continuam válidas (mesmo `argvHash`), pelo que o comando repetido passa sem voltar ao inbox.

### Adaptador direto

O `DirectAdapter` passa a respeitar `approval_required` pela mesma `ApprovalHandler` no `run_command` (fecha o minor herdado da 1B-2). Sem `sessionId`, um timeout reinicia o nó.

## 5. Ciclo de vida dos runs e concorrência

- Estados de run: `queued` (novo, inicial), `running`, `waiting_human`, `waiting_approval` (novo), `paused_budget`, `completed`, `failed`, `cancelled`. `RunCreated` coloca o run em `queued`; `RunStarted` (novo evento) marca a passagem a `running` quando o daemon lhe dá uma vaga. Replays de runs antigos sem `RunStarted` continuam válidos: o reducer trata `NodeStarted` como arranque implícito.
- Limites: `max_concurrent_runs` global em `daemon.yaml` (4) e `max_concurrent_runs` em `org.yaml` (2). Fila FIFO por ordem de `RunCreated`; um run só arranca se ambos os limites o permitem.
- Worktree: criado no `POST /runs` antes do `RunCreated`, como hoje no CLI (preflight incluído). Falha de preflight com `workspace: worktree` explícito → 400; com o modo por defeito cai para inplace, e o aviso vai no log do run e na resposta do `POST` (`{ runId, warnings: [] }`).
- Retoma no arranque do daemon: `queued` e `running` sem processo vivo voltam à fila (o motor reentra nós por ordem, como no `resume` atual); `waiting_*` e `paused_budget` esperam.
- `cancel` aborta o `AbortSignal` do run (já existe) e, para runs Claude Code, aborta a query.

## 6. Agendamentos

- `schedules` no SQLite; cron avaliado com `croner`, fuso do sistema. Tick a cada minuto.
- Ao vencer, submete um run igual ao `POST /runs` com os campos guardados; `last_run_id` atualizado. Se o `last_run_id` ainda não é terminal, salta e escreve no log do daemon ("Skipped schedule <id>: previous run <runId> is still running").
- CLI: `shibaox schedule add "<cron>" <workflow> --project <p> [--input ...] [--adapter ...] [--budget ...]`, `schedule list`, `schedule rm <id>`, `schedule run <id>` (dispara já).

## 7. Stream de eventos

Envelope SSE: `id: <índice>`, `event: run | runtime`, `data: <json>`.

- `run`: um `RunEvent` do log (`StoredEvent`).
- `runtime`: `{ runId, nodeId, at, event: RuntimeEvent }`, não persistido no log de eventos (persistência do transcript fica para 2C), mas guardado num buffer circular por run (últimas 2000 entradas) para que `follow` de um run em curso mostre o que já passou.
- `RuntimeEvent` ganha, de forma aditiva: `tool_use.id`, `tool_result.id` e `tool_result.durationMs`, e `parentToolUseId?` em `text`/`tool_use`/`tool_result` quando vêm de um subagente do Claude Code (`parent_tool_use_id` do SDK). O adaptador direto preenche `id` e `durationMs`.
- `text` e `tool_result` são truncados a 4 kB por evento no stream.

## 8. Canais

```ts
interface Channel {
  id: 'macos' | 'telegram';
  notify(req: InboxItem): Promise<void>;                 // pode falhar; o outbox repete
  onAnswer?(cb: (id: string, a: InboxAnswer) => void): void;
}
```

- **macOS**: `osascript -e 'display notification ...'`; se `terminal-notifier` existir no PATH, usa-o (permite clicar para abrir o terminal). Sem resposta. Noutros SO o canal não é registado.
- **Telegram**: Bot API por `fetch`. Token lido do env indicado em `daemon.yaml` (`SHIBAOX_TELEGRAM_TOKEN`), `chat_id` fixo. Mensagem: "Approval needed\nRun abc12 · node ship · role backend\n`git push origin main`" com botões inline `Approve` / `Deny`; nós `human` levam o `prompt` e os mesmos botões. Long polling (`getUpdates`, 30 s), só aceita `callback_query` cujo `chat.id` é o configurado; qualquer outra origem é ignorada e registada. Ao responder, edita a mensagem para "Approved by Telegram" / "Denied by Telegram". Nunca envia conteúdo de ficheiros, diffs ou saídas de ferramentas.
- Outbox: cada `InboxItem` novo gera uma linha por canal; envio com backoff 5 s, 30 s, 2 min, 10 min, depois de hora a hora; removida ao resolver o pedido.
- Texto de todas as mensagens e do CLI segue a voz do design system: sentence case, verbo-primeiro, sem emoji, erro = o que aconteceu + o que fazer.

## 9. CLI

| Comando | Comportamento |
|---|---|
| `run <workflow> --project ... --input ...` | submete; sem `--detach` segue o stream; Ctrl-C deixa o run a correr e imprime "Run abc12 keeps running. Follow it with: shibaox follow abc12" |
| `follow <runId>` | SSE desde o início ou `--since <idx>` |
| `runs`, `replay`, `resume`, `cancel` | via daemon; `replay --db <path>` continua offline |
| `inbox` | lista pendentes; `approve <id> [--note]`, `deny <id> [--note]` |
| `schedule add\|list\|rm\|run` | secção 6 |
| `daemon start [--detach]\|stop [--force]\|status` | secção 1 |
| `doctor` | acrescenta: daemon (a correr, versão igual à do CLI), Telegram (token presente, `getMe` ok), `claude` autenticado (`claude auth status` se disponível) |

Todos os comandos aceitam `--json` (uma linha JSON por objeto; `follow` e `run` sem `--detach` emitem um envelope por linha). `process.exitCode` mantém-se: 0 sucesso, 1 erro, 2 run terminou `failed`.

Comandos que existiam com `--org`: mantêm-no; o `orgRoot` vai no pedido ao daemon.

## 10. Alterações em pacotes existentes

- `@wizardingcode/shibaox-schemas`: eventos `RunStarted`, `SessionStarted`, `ToolApprovalRequested`, `ToolApprovalResolved`, `NodeSuspended`; `RunCreated.orgRoot?`; `org.yaml` `max_concurrent_runs?`.
- `@wizardingcode/shibaox-core`: `RunStatus` + `queued`, `waiting_approval`; reducer para os eventos novos (`sessionId` por nó, aprovações por nó, `queued` até `RunStarted`/`NodeStarted`); `AdapterErrorReason` + `approval_pending`; `EngineDeps.approvals?: ApprovalHandler`; `TaskJob.resumeSessionId?`, `resumeNote?`, `approvedArgv?: string[]` (hashes já resolvidos); `EventStore.subscribe`; `RuntimeEvent` aditivo (secção 7); o motor ganha `engine.create(req)` (emite `RunCreated`, devolve `runId`, run fica `queued`) e `engine.run(runId)` (emite `RunStarted` e executa); `engine.start` passa a ser `create` seguido de `run`, para os testes e o modo sem daemon continuarem válidos.
- `@wizardingcode/shibaox-adapter-claude-code`: opção `approvals`, timeout, `SessionStarted` a partir do `init`, `resume` por `sessionId`, `parent_tool_use_id` mapeado, ids e durações de ferramentas.
- `@wizardingcode/shibaox-adapter-direct`: `approvals` no `run_command`, ids e durações.
- `@wizardingcode/shibaox-persistence-sqlite`: `subscribe`, tabelas `schedules` e `channel_outbox`, migração idempotente.
- `apps/cli`: `wiring.ts` migra para `packages/daemon/server` (o daemon é o único que constrói runtimes); o CLI fica só com cliente + apresentação.

## 11. Erros

| Situação | Comportamento |
|---|---|
| Daemon não arranca | "Could not start the shibaox daemon. See ~/.shibaox/daemon.log" e exit 1 |
| Versão do daemon ≠ CLI | `GET /health` devolve a versão; o CLI recusa comandos de escrita com "Daemon 0.3.0 is older than this CLI (0.4.0). Restart it: shibaox daemon stop && shibaox daemon start"; comandos de leitura avisam e continuam |
| Socket órfão | removido e recriado no arranque |
| `POST /runs` inválido | 400 com a mesma mensagem `cannot start: ...` de hoje; nenhum evento |
| Org alterado durante um run | o run usa o snapshot em `RunCreated` |
| Telegram sem rede | outbox repete com backoff; inbox local continua a funcionar |
| Resposta duplicada | a primeira ganha; a segunda recebe 409 "already resolved" (Telegram: mensagem editada) |
| Timeout de aprovação | nó suspenso, pedido continua pendente; ao responder, retoma |
| `resume` de run `waiting_approval` com pedido pendente | 409 "answer the pending approval first: shibaox approve <id>" |
| Worktree removido de um run não terminal | 409 no `resume`, com o caminho e "see: shibaox worktree list --project <p>" |

## 12. Testes

- **Daemon em memória**: SQLite temporário, socket em diretório temporário, adaptador `mock` com ganchos para pedir aprovação. Casos: submit → queued → running → completed; limite de concorrência (3 runs, limite 2, o terceiro espera); aprovação de ferramenta bloqueia e resolve por `POST /inbox`; nó `human` idem; restart a meio (novo daemon sobre a mesma base retoma `running` e mantém `waiting_approval`); `cancel` durante `waiting_approval`; SSE com `Last-Event-ID`; `--json` em todos os comandos.
- **Adaptador Claude Code com fake query**: `canUseTool` bloqueia até `approvals.request` resolver; `argvHash` já aprovado passa sem pedir; timeout produz `approval_pending`; `SessionStarted` emitido; retoma chama `query` com `resume` e o prompt de nota; `parent_tool_use_id` mapeado.
- **Reducer**: `queued`→`running`, `NodeSuspended`, aprovações por nó, replay determinístico com os eventos novos.
- **Telegram** com servidor HTTP falso: envio, botões, resposta de chat id errado ignorada, backoff.
- **Agendamentos**: relógio falso, tick submete, run ainda ativo salta.
- **Reais opt-in** (`SHIBAOX_REAL_TESTS`): `git push` numa task Claude Code chega ao inbox e é aprovado; `apiKeySource` de um papel de subscrição.
- Higiene: todos os testes limpam diretórios temporários e sockets.

## 13. Fora de âmbito da 2A

Interface Ink (2A-2), swarm dinâmico e merge queue (2B), servidor central, Postgres, FalkorDB, autenticação de rede e persistência do transcript (2C), loop de aprendizagem (2D), WhatsApp/Slack/Discord (canais seguintes pela mesma interface), launchd/systemd e Electron (fase 3), adaptadores Codex/Cursor (fase 4).

## 14. Verificação da 2A

- `pnpm test` verde em todos os pacotes, incluindo o daemon em memória.
- Cenário real com `mock`: `shibaox daemon start --detach`; `shibaox run hello-feature --project examples/sample-repo --input "..."`; fechar o terminal; `shibaox runs` mostra o run a progredir; `shibaox inbox` mostra o nó `ship`; `shibaox approve human:<run>:ship`; run `completed`.
- Cenário real com `claude-code` (subscrição): task que faz `git push` → notificação macOS e mensagem Telegram → `Approve` no telemóvel → push feito, run continua. Repetir com `daemon stop` a meio da espera e `daemon start` depois: o pedido continua no inbox e a sessão é retomada por `session_id` após a resposta.
- Agendamento `*/5 * * * *` submete runs e salta quando o anterior ainda corre.
