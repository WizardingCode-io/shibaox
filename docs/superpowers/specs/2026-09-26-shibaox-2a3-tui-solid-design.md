# shibaox — Fase 2A-3: painel de terminal ao nível do opencode (OpenTUI + Solid)

Data: 2026-09-26. Substitui o painel da fase 2A-2 (`apps/tui`, OpenTUI + React), que o
Andre rejeitou por ser "amador": molduras à volta de espaço vazio, sem tema, sem motion,
sem conteúdo para runs terminados.

## Contexto

O opencode v2 (`github.com/anomalyco/opencode`, branch `v2`, MIT) usa a mesma versão do
OpenTUI (0.5.12) e é a referência de qualidade: superfícies elevadas em vez de molduras,
tema semântico, animações como renderables nativos, diálogos e toasts, sessão como
conversa. Este documento desenha o shibaox nesse nível, reutilizando as primitivas do
opencode onde são genéricas e desenhando os ecrãs do shibaox de raiz.

## Decisões

| Tema | Decisão |
|---|---|
| Binding | `@opentui/solid` 0.5.12 + `solid-js` 1.9, sob Bun (o CLI Node continua a lançar o Bun). React sai. |
| Ecrã principal | Sessão de run como conversa (opção B), com home tipo opencode (logo + prompt). A lista de runs vive na sidebar. |
| Primitivas | Copiadas do opencode com atribuição MIT em `apps/tui/THIRD_PARTY.md`: animation, one-cell-motion, subcell, masked-text, shimmer-text, fade-in-text, tab-pulse (funções), toast, dialog, delayed-presence, marquee, layout helpers. Adaptadas ao mínimo (tema e config do shibaox). |
| Tema | Formato semântico do opencode (escalas de tonalidade + tokens `text`/`background`/`border`/`feedback`/`action`), um único tema `shibaox` gerado dos tokens do design system. Resolver próprio, reduzido (sem v1, sem syntax de markdown além do necessário). |
| Teclas | Scopes próprios (`context/keys.tsx`: pilha `dialog > prompt > pane > global`) sobre `useKeyboard` do `@opentui/solid`. O pacote `@opentui/keymap` fica para uma fase posterior (o opencode envolve-o em 470 linhas próprias). |
| Fronteira | O Bun importa apenas `@wizardingcode/shibaox-daemon/client` e `@wizardingcode/shibaox-core` (tipos). O teste de fronteira mantém-se. |
| Daemon | Ganha `GET /runs/:id/diff` (diff do worktree do run). Nada mais muda no daemon. |
| Rato | Suportado: clicar em runs, tabs, toasts e diálogos; hover; scroll na conversa; redimensionar a sidebar. |

## 1. Pacote e arranque

`apps/tui` é reescrito de raiz (o código React é apagado, incluindo testes).

```
apps/tui/
  package.json           @opentui/core, @opentui/solid, solid-js, opentui-spinner, fuzzysort
  bunfig.toml            [test] root = "test"
  THIRD_PARTY.md         atribuição MIT do opencode para os ficheiros copiados
  src/main.tsx           entrada Bun (mesmos argumentos da 2A-2: dashboard|stream <runId> --socket --home --version --cwd)
  src/app.tsx            runDashboard / runStream: cria o renderer, monta <App>, resolve com o código de saída
  src/theme/             shibaox.json, resolve.ts (escalas → tokens RGBA), context.tsx (useTheme, surface)
  src/motion/            animation.ts, one-cell-motion.ts, subcell.ts, masked-text.ts, shimmer-text.tsx, fade-in-text.tsx, pulse.ts, spinner.tsx
  src/ui/                dialog.tsx, toast.tsx, border.ts, layout.ts, marquee.ts, delayed-presence.ts
  src/context/           client.tsx, data.tsx (stores + poller), route.tsx, keys.tsx, prefs.tsx, exit.tsx
  src/routes/home.tsx    logo + prompt
  src/routes/session/    index.tsx (frame), timeline.tsx, node-card.tsx, tool-line.tsx, gate-card.tsx, decide-card.tsx, summary-card.tsx, approval-bar.tsx, diff.tsx
  src/component/         logo.tsx, tabs.tsx, sidebar.tsx, footer.tsx, prompt/ (input + autocomplete), command-palette.tsx, reconnecting.tsx, help.tsx
  src/model/             pure: stream.ts (frames → timeline), status.ts, format.ts, prompt-commands.ts
  src/testing/fake-client.ts
  test/                  bun tests (frames capturados e lógica pura)
```

O CLI (`apps/cli/src/commands/ui.ts`, `run.ts`) não muda de contrato: `shibaox` abre o
painel, `shibaox run …` submete e abre a sessão do run, `shibaox follow <id>` abre a sessão
de um run só (modo `stream`), e o estado final continua a ser impresso quando o Bun sai.

## 2. Tema

`src/theme/shibaox.json` segue o esquema do opencode: `hue` com escalas (`neutral`,
`interactive`, `green`, `red`, `yellow`, `cyan`, `blue`, `purple`, `orange`, passos
100–900) e tokens semânticos com referências `$hue.x.y` / `$text.base`. Valores vêm do
design system (`~/Projects/shibaox/design-system`): neutros quentes (fundo `#1a1614`,
elevado `#231e1b`, `#2c2622`, `#37302b`; texto `#f1e9df` / muted `#b9a694`), `interactive`
= laranja shiba (`#ffa15c` no passo 200), verde matcha `#6acb8e`, vermelho `#ff7a8a`,
amarelo `#f2c150`, ciano `#7fd3e6`, azul `#86aef5`.

`resolve.ts` transforma o JSON em `ResolvedTheme` (RGBA): `text.{base,muted,feedback.*,
action.primary.{base,focused,selected,disabled}}`, `background.{base,raised.{base,high,max},
feedback.*,action.primary.{hovered,focused,selected}}`, `border.base`, `scrollbar.base`,
`diff.*`, `syntax.*` (o que o `CodeRenderable` pede). `surface('dialog'|'sidebar'|'toast')`
devolve o tema re-resolvido com o fundo elevado como base.

Regras: estado nunca só por cor (símbolo + palavra em `model/status.ts`, como na 2A-2);
`prefs.animations=false` ou `SHIBAOX_NO_MOTION=1` desliga todo o motion (spinners viram
`▪`, fades e shimmers não animam, springs saltam para o alvo).

## 3. Motion

- **FadeInText**: cada linha nova da conversa entra com varrimento de 200 ms (renderable
  nativo, `colorMatrix` por célula).
- **ShimmerText**: o status "Working" do header e o texto "a pensar…" do nó ativo.
- **OneCellSpinner**: uma célula por nó em execução (`block-soft-sweep`), com `pace` que
  abranda após 30 s. Spinner braille nos toasts e overlays.
- **Pulse** nas tabs: um run em segundo plano que termina ou precisa de ti faz a tab pulsar
  três vezes (funções `attackDecay`/`intensityAt` do opencode) e fica marcada até ser aberta.
- **Spring** na largura da sidebar ao abrir/fechar (`createAnimatable`, `visualDuration` 0,25 s).
- **Presença atrasada**: overlays de loading e "a reconectar" só aparecem após 500 ms e
  ficam pelo menos 1 s.
- **Marquee** em títulos que não cabem na tab/sidebar.

## 4. Ecrãs

### 4.1 Home

Centrado: logo shibaox em ASCII com sombra (`component/logo.tsx`, dois tamanhos: ≥ 44
colunas e < 44; escondido abaixo de 12 linhas), abaixo o prompt (largura máx. 75) com
placeholder rotativo ("Adiciona um endpoint /health", "Corrige os testes do módulo X"),
e por baixo uma linha de contexto muda: `org · workflow · projeto · adapter · budget`.
Footer (1 linha): estado do daemon à esquerda (`daemon 0.0.1 · 2 running · 1 queued ·
▲ 1 needs you`) e atalhos à direita.

Comandos `/` no prompt (autocomplete fuzzy, `component/prompt/autocomplete.tsx`):
`/workflow <nome>` (lista lida do org), `/project <dir>`, `/org <dir>`, `/adapter
mock|claude-code|direct`, `/budget <usd>`, `/workspace inplace|worktree`, `/runs` (abre o
seletor), `/help`. Os valores ficam em `~/.shibaox/ui.json` (`lastOrg`, `lastAdapter`,
`lastWorkflow`) como na 2A-2. Enter com texto submete (`submitRun`), mostra toast
"Run <id> queued" e navega para a sessão.

### 4.2 Sessão de run

Layout (esquerda → direita): rail de tabs (vertical, 20 colunas, quando `width ≥ 106`;
senão uma linha horizontal no topo), conversa (flexGrow), sidebar (42 colunas, quando
`width − rail ≥ 120` ou aberta a pedido; redimensionável 24–72 com o rato).

**Header** (1 linha, fundo elevado): `fe4a4950 · hello-feature · ● Working · $0.0020 ·
2m 13s` (status com shimmer enquanto working; palavra + símbolo de `status.ts`).

**Conversa** (`timeline.tsx`, scrollbox, segue o fim enquanto não há scroll manual; `G`
volta ao fim): uma sequência de cartões derivada de `model/stream.ts` a partir dos frames
(`run`, `runtime`, `end`) do stream do daemon mais o `RunState`:

- `NodeCard` (task): cabeçalho `▸ implement · backend · claude-code · 3 tools · $0.0012 ·
  41 s` com spinner enquanto corre. Corpo: blocos de texto do agente em Markdown
  (`<markdown>` nativo), `ToolLine` por `tool_use` (`> Read src/a.ts · 7 ms · done`),
  colapsada por defeito; `enter`/click expande e mostra o input resumido e o output
  (`STORED_TEXT_LIMIT` já aparado pelo daemon) em `<code>`; `file_changed` como `± src/a.ts`.
- `GateCard` (gate): lista de checks com `✓`/`✗`, nome e duração; se reprovar, o relatório
  do `GateFailed` em Markdown.
- `DecideCard` (decide): `judge → ship (0.91)`; confiança em cor de feedback.
- `HumanCard` (human): o prompt e a resposta (quem e quando), ou "à espera" com o
  `ApprovalBar` no fundo.
- `SummaryCard` no fim: `✓ Done · 5 nodes · $0.0020 · 3m 02s · 4 files changed · branch
  shibaox/run-fe4a4950` ou `✗ Failed · <erro>`; `d` abre o diff.
- Erros de adapter (`error`) como cartão de feedback vermelho.

Runs terminados replicam o histórico (`?history=1`), por isso um run antigo mostra a mesma
conversa. Runs sem stream (mock, ou retirados do buffer) mostram os cartões de nós a partir
do `RunState` apenas (estado, tentativas, custo), sem corpo.

**Fundo da coluna** (2–4 linhas): quando o run tem `pendingApprovals` ou `pendingHumans`,
o `ApprovalBar` substitui o prompt: `▲ git push origin main · backend · [a]pprove [d]eny
[n]ote`; `a`/`d` respondem, `n` abre a nota e responde com ela. Aprovações de comando
pedem `y` de confirmação (como na 2A-2). Sem pendentes: linha de atalhos contextuais
(`enter expand · d diff · c cancel · r resume · ctrl+o runs · ? help`).

### 4.3 Tabs

Um run aberto = uma tab (título: `id curto · workflow`, marquee se não couber). Estado por
símbolo + cor; pulse ao terminar/precisar em segundo plano. `ctrl+]`/`ctrl+[` mudam;
`ctrl+w` fecha; click seleciona. A home é sempre a primeira tab (`⌂`).

### 4.4 Sidebar

Fundo elevado, três blocos: **Runs** (hoje / ontem / anteriores, cada linha `● fe4a4950
hello-feature 2m` com status; click ou `enter` abre em tab; `j/k` quando focada),
**Needs you** (inbox pendente de todos os runs, `a`/`d` respondem ao selecionado), **This
run** (ficheiros alterados e custo por nó). `ctrl+b` abre/fecha; `tab` alterna o foco
conversa ↔ sidebar.

### 4.5 Diálogos e overlays

Stack (`ui/dialog.tsx`) com fundo escurecido `rgba(0,0,0,150/255)`, largura 60/88/116,
`esc` fecha o topo:

- **Runs** (`ctrl+o`): lista fuzzy de todos os runs (id, workflow, status, idade, custo).
- **Command palette** (`ctrl+k`): todas as ações com as teclas, filtrável.
- **Help** (`?` fora de inputs, `/help`): teclas por contexto.
- **Confirmar cancelar** (`c` na sessão): `Cancel run fe4a4950? (y/n)`.
- **Diff** (`d`): `<diff>` nativo do worktree, ficheiro a ficheiro (`]`/`[` mudam), com
  `GET /runs/:id/diff`; runs `inplace` mostram o diff do projeto.
- **Reconnecting**: overlay a ecrã inteiro quando o daemon não responde há > 2 s
  (presença atrasada), desaparece ao voltar. Com o daemon em baixo, as ações apenas
  mostram toast "Daemon unreachable".
- **Terminal too small**: abaixo de 60×15, um aviso centrado.

### 4.6 Toasts

Canto superior direito, bordas laterais `┃`, fila com "+N more", pausa em hover, ação
opcional (`› Open`): run terminou/falhou em segundo plano (ação abre a tab), "Already
answered elsewhere" (409), erros de ação, daemon de volta.

## 5. Teclas (scopes)

Globais: `ctrl+q` sair; `ctrl+c` no prompt limpa o texto, fora do prompt sai (o daemon
continua os runs); `ctrl+n` home/novo run; `ctrl+o` runs; `ctrl+k` palette; `ctrl+b`
sidebar; `ctrl+]`/`ctrl+[`/`ctrl+w` tabs; `?` ajuda (fora de inputs).
Sessão (foco na conversa): `j/k`/setas scroll, `enter` expande/colapsa, `G` fim, `d` diff,
`c` cancelar, `r` retomar (`paused_budget`), `a`/`d`/`n` quando há pendente (o `d` de diff
cede ao `d` de deny enquanto houver pendente), `tab` sidebar.
Sidebar: `j/k`, `enter`, `a`/`d`, `tab` volta.
Diálogos: `esc`, `enter`, setas, texto filtra.
Modo `stream` (follow de um run): sem tabs nem home; `q`/`ctrl+c` saem e o CLI imprime o
estado final; termina sozinho quando o run acaba (código 0/2 como na 2A-2).

## 6. Dados

`context/data.tsx` mantém stores Solid (`createStore`) alimentadas por um `Poller` com a
mesma política da 2A-2: `listRuns` + `inbox` a cada 1 s (500 ms após uma ação, 5 s enquanto
inacessível), uma subscrição SSE por tab aberta (`history=1` ao abrir, cursor composto),
`getRun` ao abrir e a cada evento `run` (throttle 200 ms). `model/stream.ts` é puro:
`reduceTimeline(state, frames) → Card[]` com testes vitest. Nada no Bun lê SQLite.

Daemon: `GET /runs/:id/diff` → `{ base: string, files: [{ path, status: 'added'|'modified'|
'deleted'|'renamed', additions, deletions }], patch: string }`, calculado com `git diff
<base>` no `workspace` do run (`base` = o commit registado em `RunCreated`/worktree, ou
`HEAD` se `inplace`); 404 `no_workspace` se a pasta já não existir; `patch` limitado a
2 MB (`truncated: true` acima). `DaemonClient.diff(id)`.

## 7. Erros e limites

- Daemon inacessível: overlay + toasts; nunca crash; retoma sozinho.
- 409 ao responder: toast e o item sai da lista.
- Frames malformados: ignorados com `console.error` no log do TUI (`~/.shibaox/tui.log`).
- Conversa limitada a 5.000 cartões por run (os mais antigos colapsam num "… N earlier").
- Terminal < 60×15: aviso; redimensionar recalcula tudo (`useTerminalDimensions`).
- Bun em falta/antigo, sem TTY: mensagens do CLI da 2A-2 mantêm-se.

## 8. Testes

- `bun test` com `createTestRenderer` + `testRender` do `@opentui/solid`: home (logo,
  prompt, comandos `/`, submit), sessão (cartões por tipo a partir de frames, expandir tool,
  approval bar a/d/n, summary, diff dialog), tabs (abrir/fechar/pulse), sidebar (lista, inbox,
  resize), diálogos (runs fuzzy, palette, help, cancel), toasts (fila, 409), reconnecting,
  too small, teclas por scope, `SHIBAOX_NO_MOTION`.
- vitest para `model/*` (reduceTimeline, status, format, prompt-commands), `theme/resolve`.
- Teste de fronteira (`bun -e` importa `src/app.tsx`, sem `better-sqlite3`/daemon).
- Daemon: `GET /runs/:id/diff` (worktree com alterações, inplace, pasta apagada, truncado).
- Validação final em pty real contra o daemon do Andre, com capturas.

## 9. Fora de âmbito

Temas adicionais e claros (a estrutura fica), plugins, terminal embutido, editor de
workflows, adaptadores Codex/Cursor, cliente HTTP remoto (2C), notificações sonoras.

## 10. Verificação

1. `pnpm test` e `pnpm lint` verdes; `bun test` em `apps/tui`.
2. `cd ~/shibaox-demo && shibaox` mostra a home com logo e prompt; `/workflow hello-feature`
   autocompleta; enter submete e abre a sessão com o nó `analyse` a girar.
3. Um run terminado mostra os cartões e o `SummaryCard`; `d` abre o diff.
4. Um run com aprovação pendente mostra o `ApprovalBar`; `a` aprova e o run avança.
5. Parar o daemon mostra o overlay; arrancá-lo retira-o e os dados voltam.
6. `SHIBAOX_NO_MOTION=1 shibaox` não anima nada e continua legível.
