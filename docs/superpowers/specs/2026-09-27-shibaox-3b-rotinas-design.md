# shibaox 3B — rotinas 24 h: serviço, relatórios e Telegram com texto

Data: 2026-09-27. Base: `main` em `97d40b1` (3A integrada).

## Objetivo

O shibaox trabalha quando não estás ao terminal: o daemon arranca com a sessão e volta a
arrancar se cair (launchd); os runs agendados e os runs pedidos de fora **entregam um
relatório** onde os pediste (Telegram, notificação macOS) e no vault; e podes **falar com o
orientador pelo Telegram** (texto livre → run `chat` da org configurada; a resposta volta ao
chat; os workflows que ele despacha reportam o fim no mesmo chat).

Fora de âmbito: systemd (Linux) e Windows (a mesma estrutura, noutra fase); continuação
automática do orientador no Telegram quando um filho termina (o painel já o faz; no Telegram
chega o relatório do filho e o utilizador continua a conversa); outros canais (Slack, e-mail).

## 1. Origem dos runs

- `RunCreated.origin?: string` (schema, reducer, `RunState`, `StartOptions`, `SubmitRequest`,
  `RunSummaryPlus`): quem pediu o run. Valores: `schedule:<id>`, `telegram:<chatId>`; runs da
  CLI/painel ficam sem origem (não recebem relatório por canal; o painel mostra-os).
- O `Scheduler` submete com `origin: schedule:<id>`. Um run filho (`start_workflow`) herda a
  origem do pai.

## 2. Relatório no fim do run

- `buildRunReport(state, events, workflow)` (`daemon/runs/report.ts`) → `RunReport { runId,
  workflow, status, origin?, project, spentUsd, durationMs, nodes: {id, status, summary?}[],
  needs?: string (o que espera de ti: prompt do human/approval pendente), error?, branch?,
  reply?: string (a resposta do orientador num run de conversa: texto do último nó), notePath? }`.
- Quando um run **com origem** termina (terminal) ou fica à espera (`waiting_human`,
  `waiting_approval` — o inbox já anuncia o pedido; o relatório só no fim), o daemon constrói
  o relatório e mete-o na outbox para os canais que o suportam (`Channel.report?(r)`); a
  outbox persiste e repete com backoff como já faz para o inbox (payload
  `{ type: 'report', report }`; linhas antigas continuam a ser `InboxItem`).
- Telegram: `telegramReportText(r)` — para um run de conversa envia só a resposta (`reply`,
  em blocos de ≤ 4000 chars, HTML escapado); para os outros `✓ hello-feature done · 5 nodes ·
  $0.12 · 8m · branch …` + resumos por nó (≤ 200 chars cada) + `needs` quando existe.
  macOS: título/status numa notificação. A nota do vault é a que `finishRun` já escreve; o
  seu caminho vai no relatório (`notePath`) e na mensagem.

## 3. Telegram com texto

- `daemon.yaml` `channels.telegram` ganha `org`, `project` (caminhos), `workflow` (default
  `chat`) e `adapter?`. Sem `org`/`project`, o texto recebe "Set channels.telegram.org and
  project in daemon.yaml to talk to the orchestrator".
- O canal pede `allowed_updates: ['callback_query','message']`; uma `message` de texto do
  `chat_id` permitido vai a `onMessage(text)` (mensagens de outros chats são ignoradas e
  registadas). `/status` responde com a saúde do daemon (versão, runs a correr/na fila, o que
  precisa de ti); `/help` lista isto. Qualquer outro texto é um turno: o daemon submete
  `{ workflow, orgRoot, project, adapter, input: text, messages, workspace: 'inplace', origin: telegram:<chatId> }`
  e responde `…` (`sendChatAction typing`). A conversa por chat (últimos 20 turnos: pedido +
  resposta) vive em memória no daemon (perde-se ao reiniciar; a memória de longo prazo é a
  do orientador).
- A resposta chega pelo relatório (ponto 2, `reply`); um erro chega como `✗ chat failed: …`.

## 4. Serviço (launchd, macOS)

- `shibaox daemon install` escreve `~/Library/LaunchAgents/io.shibaox.daemon.plist`
  (`Label io.shibaox.daemon`, `ProgramArguments: [/bin/zsh, -lc, "exec <node> <cli> daemon start"]`
  para herdar o ambiente do login shell — chaves e token nunca ficam no plist —, `RunAtLoad`,
  `KeepAlive`, `StandardOutPath`/`StandardErrorPath` = `daemon.log`, `WorkingDirectory` =
  home do shibaox), para o daemon detached se existir, e faz `launchctl bootstrap gui/<uid>
  <plist>` (fallback `launchctl load -w`). `daemon uninstall` faz `bootout` e apaga o plist.
  `daemon status` e `doctor` dizem `service: launchd (installed)` / `not installed`.
- `daemon stop` com o serviço instalado: o launchd volta a arrancá-lo (KeepAlive); a mensagem
  diz isso e aponta para `daemon uninstall`.

## Ficheiros

- `packages/schemas/src/events.ts`, `packages/core/src/run/{state,reducer,engine}.ts`
- `packages/daemon/src/{run-manager,scheduler,daemon,config,server,client}.ts`,
  `packages/daemon/src/channels/{types,outbox,telegram,macos}.ts`,
  `packages/daemon/src/runs/report.ts` (novo), `packages/daemon/src/service.ts` (novo)
- `apps/cli/src/commands/{daemon,doctor}.ts`, `apps/cli/src/index.ts`
- README (Daemon: serviço, relatórios, Telegram).

## Verificação

- Testes: report puro; outbox com payload de relatório; Telegram (Bot API falso): texto →
  `onMessage`, `/status`, chat de outro id ignorado, relatório de conversa em blocos;
  run-manager: run com origem termina → `onFinished`; scheduler passa a origem; service
  (exec falso): plist gerado, bootstrap/bootout, status.
- Real: `shibaox daemon install` instala e o daemon fica a correr pelo launchd (`launchctl
  print`), `daemon status` mostra o serviço; `schedule run` de um schedule de chat com origem
  termina e o daemon regista `report:` no log (sem Telegram configurado nesta máquina, o
  canal macOS recebe a notificação).
