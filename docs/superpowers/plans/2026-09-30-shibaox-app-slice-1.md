# App, fatia 1: fundação + Chats — plano

> Executado inline (processo habitual: testes primeiro, revisão Opus no fim, uma passagem de correcções, merge, release). Spec: `docs/superpowers/specs/2026-09-30-shibaox-app-design.md`.

**Objectivo:** `shibaox app` abre no browser a app do mockup (sidebar, thread, composer), a falar com o daemon local (ponte) ou remoto (`/app` servido pelo daemon), com Chats, Tasks e Logs, aprovações, steer, cancel e modelo por run.

**Arquitectura:** `packages/view` (derivações puras, sem Node), `apps/app` (React 18 + Vite, design system vendorizado), o daemon serve `/app`, a CLI ganha `shibaox app` com uma ponte loopback.

## Restrições globais

- Só componentes e tokens do design system; sentence case; verb-first; sem emoji; Shiba uma vez por ecrã.
- A app nunca importa código de execução de `core`/`daemon` (só `import type`): tudo o que corre no browser vem de `packages/view` ou de `apps/app`.
- Segredos: o token só em `localStorage` da app e no fragmento da URL na primeira carga (removido da barra).
- biome do monorepo; vitest; `pnpm build` com a app antes do daemon.

## Tarefas

### T1 `packages/view` — derivações partilhadas
- Novo pacote `@wizardingcode/shibaox-view` (deps: `core`, `daemon`, `schemas` só em `import type`; zero runtime deps).
- `src/stream.ts` = mover `apps/tui/src/model/stream.ts` (com o seu teste); o TUI passa a importar de `view` (`model/stream.ts` vira re-export).
- `src/request.ts`: `requestText(input)` (do TUI, sem JSX).
- `src/conversation.ts`: `ChatMessage`, `conversationOf(input)`, `isEventTurn(input)` (cópias das de core, com nota).
- `src/thread.ts`: `threadView(turns: {state: RunState; cards: Card[]}[]) → { title, status: AgentStatus, messages: ThreadMessage[], toolsByMessage, tasks: string[] }` onde `ThreadMessage = {key, from: 'user'|'agent', text, time?, blocks: Block[], pending?: boolean}`; `agentStatusOf(state)`: running→working, waiting_human→waiting, completed→online, failed/cancelled→error, none→idle.
- Testes: `thread.test.ts` (uma thread com 2 turnos, tool blocks agrupados por turno, status por estado, título = primeiro pedido).

### T2 daemon — `/health.listen`, `/app` estático
- `Health.listen?: {host, port, tls}` no socket (`daemon.listenAddress()`); no TCP anónimo `/health` continua reduzido.
- `GET /app`, `GET /app/*`: ficheiros de `appDist()` (resolve `@wizardingcode/shibaox-app/dist` por `createRequire`; sem pacote → 404 com mensagem "install @wizardingcode/shibaox-app"); content types (html, js, css, woff2, svg, png, json, map); caminhos normalizados dentro do dist; qualquer caminho sem extensão → `index.html`; sem token (também no TCP); `GET /` no TCP → 302 `/app`.
- Testes em `server.test.ts`: serve index e um asset com o content type, 404 fora do dist, `..` recusado, sem token no TCP, `/health` com `listen`.

### T3 `apps/app` — esqueleto + design system
- `package.json` (`react`/`react-dom` 18.3.1, `vite` 8, `@vitejs/plugin-react`, `typescript`, `vitest`, `happy-dom`, `@testing-library/react`), `vite.config.ts` (`base: '/app/'`, alias `@ds` → `vendor/design-system`), `tsconfig` (jsx react-jsx, DOM), `index.html` (tokens.css, bundle.css, fontes, `<meta name="color-scheme">`).
- `scripts/sync-design-system.sh` (rsync de tokens.css, components/{bundle.css,bundle.js,index.d.ts}, fonts/, assets/Logos, assets/AppIcon/*.svg,*.png 180/512 para `vendor/design-system/`); vendorizado e commitado.
- `src/ds.ts`: `loadDesignSystem(): Promise<typeof window.Shibaox>` (define `window.React`/`ReactDOM`, `import()` do bundle), `S` como módulo com getters.
- Teste: `ds.test.ts` (happy-dom) — após `loadDesignSystem()`, `S.Button`/`S.Composer` existem.

### T4 cliente do browser
- `src/api/client.ts`: `class AppClient { constructor(base: string, token?: string) }` com `health, listRuns({thread?,status?}), getRun, submitRun, steer, cancel, resume, inbox, answer, models, projects, defaultOrg, orgInfo, audit`, e `stream(runId, since?, signal) → AsyncIterable<Envelope>` por `fetch` + `ReadableStream` (parse SSE `data:` por linha; `retry` no fecho não terminal com o último cursor).
- `src/api/connection.ts`: `readConnection(location, storage) → {base, token}` (fragmento `#token=`, apaga-o com `history.replaceState`; `base` = `location.origin`; ou `storage`), `saveConnection`.
- Testes: `client.test.ts` (fetch falso: bearer, JSON, erro HTTP tipado `AppHttpError{status}`, stream de 3 frames + `end`), `connection.test.ts`.

### T5 store + poller
- `src/store/state.ts` (`AppState`: `health, reachable, runs, inbox, states, frames, threads, open (thread activa), settings {theme, project, org, model}`), `src/store/store.ts` (`createStore(client)` com `useSyncExternalStore`, acções: `openThread, newChat(project), send(threadId, text, {model?}), stop(threadId), answer(inboxId, approved, note?), steer(runId, note), cancel(runId), resume(runId), setTheme, setDefaults`), `src/store/poller.ts` (runs+inbox a cada 2 s/5 s; SSE da thread aberta com `reduceTimeline`; `RUN_EVENT_REFRESH` refetch de estado).
- Turno novo = `submitRun({... messages: conversationOf(previous.input) + [user request] + [assistant reply], thread: rootId, model, adapter, workspace: previous.workspaceMode, budgetUsd, event?})` como o TUI.
- Testes: `store.test.ts` com um cliente falso (abrir thread → frames → mensagens; send cria o run e liga o thread; answer chama `answer`; stop chama `cancel`).

### T6 ecrãs (mockup)
- `src/App.tsx`: grelha `248px | 1fr`; `Sidebar` (Mascot 30 crop + "shibaox"; Button "New chat"; NavItems Chats (count = à espera), Scheduled, Skills, Memory, Integrations — as quatro últimas apontam a "Soon" nesta fatia; grupo RECENT; linha "me" com Avatar user (nome de Settings) + IconButton settings).
- `ThreadScreen`: `TopBar` (título, AgentStatus, Tabs Chat | Tasks (count running) | Logs), `Thread` (Message user/agent; ToolCall por block tool: status running/done/error/approval, `duration`, `args`, output em `children`; ThinkingIndicator quando running sem texto; CodeBlock para `file`/outputs longos; nós humanos como Message do agente com Approve/Deny + Input nota), `Composer` (`model` curto, `busy` = running, `onStop` = cancel, `onSend` = send); "Steer" como IconButton no TopBar (Input inline) enquanto running.
- `TasksTab`: Cards dos runs do thread (`GET /runs?thread=`) com Badge de status, custo, "Open", "Cancel". `LogsTab`: lista dos Cards do `reduceTimeline` (node/gate/decide/human/error/summary) em Cards; botão "Audit" abre `/runs/:id/audit?format=md` numa nova aba.
- `ChatsScreen` (nav Chats): lista de threads (título, projecto, status Badge, custo, hora); `ConnectScreen` (Input URL + token, Button "Connect"); `SettingsScreen` (tema, projecto/org por defeito, nome, versão do daemon, "Disconnect").
- Router por hash (`#/`, `#/chats`, `#/t/<rootId>`, `#/settings`, `#/soon/<section>`), `src/router.ts` minúsculo.
- Temas: `data-theme` no `<html>` (system → `prefers-color-scheme`).
- Testes (testing-library, cliente falso): `app.test.tsx` — estrutura do mockup presente (aside com os 5 NavItems, "New chat", topo com tabs); uma thread com tool call em aprovação mostra Approve/Deny e chama `answer`; enviar no Composer chama `submitRun` com `thread`; Connect guarda o token; tema muda `data-theme`.

### T7 CLI `shibaox app` + ponte
- `apps/cli/src/bridge.ts`: `startBridge({socketPath, dist, token, host='127.0.0.1', port=0}) → {url, close}`: serve `dist/` em `/app` (mesma lógica de estático do daemon, exportada de `daemon` como `serveAppFile`), reencaminha tudo o resto para o socket (`http.request` com `socketPath`, streaming de resposta, cabeçalhos), exige `Authorization: Bearer <token>` nos caminhos da API (401 senão), `/` → 302 `/app`.
- `apps/cli/src/commands/app.ts`: `appCommand({open?: boolean, port?: number})`: com remoto (`remote.json`/`--remote`) → URL `<base>/app#token=<token>`; com `listen` no daemon local (health.listen) → `http://host:port/app#token=<SHIBAOX_DAEMON_TOKEN do cofre>` (sem token no cofre: erro claro); senão ponte com token aleatório (32 bytes hex), imprime a URL, abre o browser (`open`/`xdg-open`/`start`), fica à espera de Ctrl-C. `--no-open` só imprime.
- Testes: `bridge.test.ts` (daemon de teste no socket: `GET /app/` → index; `GET /health` sem token → 401; com token → JSON; SSE passa); `cli-app.test.ts` (`shibaox app --no-open` com daemon → imprime uma URL com `#token=`).

### T8 docs + release 0.2.1
- Wiki: página `App` (o que é, `shibaox app`, remoto, temas, o que cada secção mostra, segurança do token), Installation/Quickstart (linha), CLI-reference (`app`), Remote-daemon (`/app`), Security (token no browser, `/app` público), Daemon-and-service (`/app`), `_Sidebar`; README bullet "A dashboard in your browser".
- Bump 0.2.1, publish, tag, daemon restart, `shibaox app` ao vivo, wiki sync, memória.

## Review focus (para a revisão Opus)
1. Token no fragmento/localStorage: fuga por `Referer`, logs, history; XSS via texto do modelo (nunca `dangerouslySetInnerHTML`).
2. `/app` estático: path traversal, content types, cache, `index.html` fallback vs. API 404.
3. SSE por fetch: retoma com cursor, cancel ao mudar de thread, backpressure, reconexão.
4. Ponte: quem pode falar com ela (loopback + token), proxy de headers, SSE e uploads, encerramento.
5. Fidelidade ao mockup e ao design system (componentes, tokens, copy).
