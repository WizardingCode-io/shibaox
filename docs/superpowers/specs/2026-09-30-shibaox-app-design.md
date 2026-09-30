# shibaox — app (browser primeiro, Electron a seguir)

Data: 2026-09-30. Decisões do Andre: entrega "1+2" (servida pelo daemon para o browser, e
Electron nesta versão; apps nativas Linux/Windows depois), âmbito "tudo" (paridade com o
painel TUI incluindo definições) e "seguir religiosamente o mockup".

## O mockup

O mockup é o `ChatScreen` do design system (`~/Projects/shibaox/design-system/components/
ChatScreen/preview.html`, o mesmo que o site mostra): grelha `248px | 1fr`, sidebar em
`surface-sunken` com marca (Mascot + wordmark "shibaox"), botão "New chat", NavItems
**Chats · Scheduled · Skills · Memory · Integrations**, grupo "RECENT", linha "me" (Avatar do
utilizador + IconButton settings); main com barra de topo (título · `AgentStatus` · `Tabs`
Chat | Tasks | Logs), thread (`Message` user/agent, `ToolCall` com aprovação,
`ThinkingIndicator`) e `Composer` (modelo em mono, busy → Stop). Tokens semânticos,
Geist/Bricolage/Geist Mono, temas light e dark, sem emoji, botões verb-first, Shiba uma vez
por ecrã. Tudo o que a app mostra usa os componentes do bundle do design system (React 18)
e os tokens; nada é redesenhado.

## Onde vive

- `apps/app` = pacote `@wizardingcode/shibaox-app`: React 18.3 + Vite + TypeScript, build
  estático em `dist/` (index.html, assets, `ds/` com o design system vendorizado).
- O design system é copiado para `apps/app/vendor/design-system/` (tokens.css,
  components/bundle.css, bundle.js, index.d.ts, fonts/, logos/app icon) por
  `scripts/sync-design-system.sh` a partir de `~/Projects/shibaox/design-system` e commitado
  (builds reproduzíveis; a fonte de verdade continua no design system). `src/ds.ts` põe
  `window.React`/`ReactDOM` e faz `import()` do bundle, exportando `S` tipado com
  `index.d.ts`.
- `apps/desktop` = Electron (macOS dmg primeiro): abre uma `BrowserWindow` com a app,
  liga-se ao daemon local pelo socket através da mesma ponte da CLI, ou a um daemon remoto
  por URL + token. Sem funcionalidades próprias nesta versão.

## Como chega ao browser

1. **Daemon serve a app**: `GET /app` e `GET /app/*` devolvem o `dist/` do pacote
   `@wizardingcode/shibaox-app` (dependência do daemon), sem token (HTML/JS/CSS públicos);
   a API continua a exigir o bearer no listener TCP. `/` redirecciona para `/app` no TCP.
2. **`shibaox app`** (CLI): se o daemon tem listener TCP (`GET /health` no socket passa a
   dizer `listen: {host, port, tls}`), abre `http://host:port/app#token=<SHIBAOX_DAEMON_TOKEN
   do cofre>`; senão arranca uma **ponte** loopback em porta efémera com um token aleatório
   por sessão, que serve o `dist/` e reencaminha `/api/*`… (todos os caminhos não-app) para o
   socket, e abre o browser. A ponte fica viva até Ctrl-C. Um daemon remoto: `shibaox app
   --remote` usa `remote.json`.
3. A app lê o token do fragmento da URL na primeira carga (e apaga-o da barra), guarda-o em
   `localStorage` com a base URL; sem token mostra o ecrã "Connect" (URL + token, "Connect").

## Cliente da API no browser

`apps/app/src/api/client.ts`: `fetch` com `Authorization: Bearer`, os mesmos caminhos e
tipos do `DaemonClient` (`import type` de `@wizardingcode/shibaox-daemon`); SSE de
`GET /runs/:id/events` por `fetch` + `ReadableStream` (o `EventSource` não manda headers),
com `since` para retomar. Poller como no TUI: `listRuns` + `inbox` a cada 2 s com uma
sessão aberta, 5 s parado; SSE só para a thread visível.

## Mapa de conceitos → ecrãs

| Mockup | shibaox |
| --- | --- |
| Chats | threads: um run raiz e os seus turnos (`thread`), incluindo runs lançados pela CLI/rotinas; RECENT = últimas 8 threads; contagem = threads à espera de ti |
| New chat | novo run `chat` no projecto/org por defeito (Settings) |
| Título · AgentStatus | primeiro pedido da thread · running→Working, waiting_human/aprovação→"Needs you", completed→Online, failed→Error, sem run→Sleeping |
| Chat | Message user (pedido) / agent (reply, texto em streaming), ToolCall por `tool_use`/`tool_result` (agrupados; aberto o que falhou ou pede aprovação; Approve/Deny ligados ao inbox), ThinkingIndicator enquanto corre sem texto, CodeBlock para outputs |
| Tasks | os runs despachados na thread (`GET /runs?thread=`): Card por run com status, custo, "Open" (abre como thread), "Steer" (nota), "Cancel" |
| Logs | timeline do run: nós, gates com evidência, decisões, aprovações (quem, via), git, custo; link "Audit" (Markdown) |
| Composer | envia um turno (`messages` como o TUI), `model` = modelo do run (clicável → escolher `GET /models`), busy → Stop = cancel |
| Scheduled | rotinas (`/routines`): Card com trigger, último run, "Run now", "Pause"/"Resume"; "Add" abre um formulário mínimo (cron/github/url/file/command, workflow, input) |
| Skills | os workflows do org (`/orgs/info`): Card com descrição e "Run task" (prompt: pedido + projecto + modelo → `POST /runs`); templates do catálogo (`type: skill`) listados |
| Memory | perfil do projecto (`/projects/profile`) e os apontamentos de continuidade das rotinas quando expostos; sem API de vault → mostra onde vivem os ficheiros |
| Integrations | MCP (`/mcp` list + "Test"), providers/modelos (`/models`: por papel, estado das chaves), Keys (set/unset; valores nunca mostrados), Tiers (`/orgs/config`) |
| Settings (engrenagem) | ligação (URL, token), tema light/dark/system, projecto e org por defeito, versão do daemon |

Aprovações: um `ToolCall` `approval` na thread e um badge "Needs you"; aprovações de
ficheiro (`tool: file`) dizem "write <path>"; nós humanos (approve-push etc.) aparecem como
uma Message do agente com Approve/Deny e nota.

## Estado e testes

- Estado em `src/store/`: `threads` (runs, eventos de runtime por run, mensagens derivadas),
  `inbox`, `routines`, `settings`; sem biblioteca externa (React context +
  `useSyncExternalStore`); redutor puro `threadView(events, runtime) → {messages, toolCalls,
  status}` testado sem DOM.
- Testes: vitest + happy-dom + @testing-library/react para ecrãs (com um cliente falso);
  unit para o cliente (fetch falso, SSE por stream), o redutor e o parser do token; no daemon,
  testes do servidor para `/app` (socket e TCP, sem token) e `/health` com `listen`; na CLI,
  a ponte (proxy + token + porta) com um daemon real de teste.
- Lint/format com o biome do monorepo; `pnpm build` inclui a app; publicação como pacote
  (o daemon depende dela, tal como do TUI).

## Fatias de entrega (cada uma: spec → testes → código → revisão Opus → merge → release)

1. **Fundação + Chats**: pacote, design system vendorizado, cliente, `/app` no daemon,
   `shibaox app` com ponte, sidebar/topo/thread/composer (Chats, Tasks, Logs), aprovações,
   steer, cancel, modelo por run, Connect e Settings mínimos, temas. Release 0.2.1.
2. **Scheduled · Skills · Memory · Integrations · Settings completo**. Release 0.2.2.
3. **Electron** (`apps/desktop`, macOS dmg; Linux/Windows depois). Release 0.2.3.

## Fora de âmbito

Edição de YAML do org na app; vault; notificações nativas; múltiplos daemons ao mesmo
tempo; mobile.
