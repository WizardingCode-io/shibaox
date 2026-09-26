# Fase 2A-3 — Painel OpenTUI + Solid ao nível do opencode: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** substituir o painel React da 2A-2 por um painel `@opentui/solid` com tema semântico, motion nativo, home com logo + prompt, sessão de run como conversa (cartões por nó, tool calls, gates, decisões, aprovações inline, resumo, diff), tabs, sidebar, diálogos e toasts, ao nível visual do opencode v2.

**Architecture:** `apps/tui` reescrito de raiz sob Bun. Primitivas de motion e UI copiadas do opencode (MIT) e adaptadas; tema resolvido de `shibaox.json`; stores Solid alimentadas por um `Poller` (sondagem + uma subscrição SSE por tab); `model/*` puro (redução de frames em cartões); ecrãs `Home` e `Session` compostos numa `App` com rotas, tabs, sidebar, diálogos e toasts. O daemon ganha `GET /runs/:id/diff`. O CLI Node continua a lançar o Bun.

**Tech Stack:** Bun ≥ 1.3, `@opentui/core@0.5.12`, `@opentui/solid@0.5.12`, `solid-js@1.9.15`, `opentui-spinner@0.0.7`, `fuzzysort@4`, TypeScript strict (`jsx: preserve`, `jsxImportSource: @opentui/solid`), `bun test` (`testRender`, `createTestRenderer`), vitest para lógica pura, biome.

**Spec:** `docs/superpowers/specs/2026-09-26-shibaox-2a3-tui-solid-design.md`

## Global Constraints

- Node `>=22` no CLI; Bun `>=1.3` no TUI. `pnpm build && pnpm test && pnpm lint` verdes (0 erros de lint; 9 warnings `noNonNullAssertion` pré-existentes aceites). `apps/tui`: `bun test` verde e `tsc --noEmit` verde.
- Dependências novas do `apps/tui`: `@opentui/core@0.5.12`, `@opentui/solid@0.5.12`, `solid-js@1.9.15`, `opentui-spinner@0.0.7`, `fuzzysort@^4`. Saem `@opentui/react`, `react`, `@types/react`. Nada mais.
- O Bun importa apenas `@shibaox/daemon/client` (runtime) e tipos de `@shibaox/daemon`, `@shibaox/core`, `@shibaox/schemas` (`import type`), mais `loadOrg` de `@shibaox/schemas` para a lista de workflows. O teste de fronteira (`test/boundary.test.ts`) tem de continuar a passar: nunca `better-sqlite3`, `persistence-sqlite`, `run-manager`, `adapter-claude-code`.
- Ficheiros copiados do opencode levam no topo `// Adapted from opencode (MIT) — https://github.com/anomalyco/opencode` e constam de `apps/tui/THIRD_PARTY.md` com a licença MIT completa.
- Copy: sentence case, verbo-primeiro, sem emoji; palavras de estado `Working`, `Needs you`, `Queued`, `Done`, `Failed`, `Paused`, `Cancelled`; estado nunca só por cor.
- Motion desligado com `prefs.animations === false` ou `SHIBAOX_NO_MOTION=1`: spinners viram `▪`, fades/shimmers desenham o texto final, springs saltam ao alvo.
- Sondagem: `listRuns` + `inbox` a 1 s (500 ms nos 3 s após uma ação, 5 s enquanto inacessível); uma subscrição SSE por tab aberta; `getRun` ao abrir e após eventos `run` (throttle 200 ms); `history=1` ao abrir.
- Tamanhos: rail vertical de tabs (20 col) quando `width ≥ 106`; sidebar 42 col (24–72 com o rato) quando `width − rail ≥ 120` ou aberta; diálogos 60/88/116; mínimo 60×15.
- Testes limpam diretórios temporários, param timers (`poller.stop()`, `renderer.destroy()`), e usam `env: { SHIBAOX_NO_MOTION: '1' }` salvo quando testam motion.
- Commits terminam com `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Notas OpenTUI/Solid (verificadas em 0.5.12)

- Render: `render(() => <App/>, renderer)` de `@opentui/solid`; renderer próprio com `createCliRenderer({ exitOnCtrlC: false, screenMode: 'alternate-screen', useMouse: true })`. Testes: `testRender(() => <X/>, { width, height })` → `{ renderer, mockInput, mockMouse, renderOnce, captureCharFrame, waitForVisualIdle, resize }`. `mockInput.pressKey(key, { ctrl?, shift?, meta? })`, `typeText`, `pressEnter/Escape/Tab/Backspace`, `pressArrow('up'|'down'|'left'|'right')`; `mockMouse.click(x, y)`, `scroll(x, y, 'down')`, `drag(x1, y1, x2, y2)`, `moveTo(x, y)`.
- Hooks: `useRenderer()`, `useTerminalDimensions()` (accessor `{width,height}`), `useKeyboard(cb)` (`key.name`, `key.ctrl`, `key.shift`; Ctrl-C = `name 'c' && ctrl`), `onResize`, `useTimeline`.
- Elementos custom: `extend({ shimmer_text: ShimmerTextRenderable })` + `declare module '@opentui/solid' { interface OpenTUIComponents { shimmer_text: typeof ShimmerTextRenderable } }`. Spinner: `registerSpinner()` de `opentui-spinner/solid` (guardar com `getComponentCatalogue().spinner` de `@opentui/solid/components`); `<spinner frames interval autoplay color/>`.
- Conteúdo: `<markdown content syntaxStyle streaming conceal/>`, `<code content filetype syntaxStyle/>`, `<diff diff view="unified" filetype showLineNumbers/>`; `SyntaxStyle.fromStyles({ 'markup.heading': { fg, bold: true }, … })` de `@opentui/core` (nomes: `markup.heading|bold|italic|strong|raw|raw.block|raw.inline|link|link.url|list|quote|strikethrough`, `keyword`, `string`, `comment`, `function`, `type`, `number`, `operator`, `punctuation`, `variable`, `property`, `constant`, `default`, `conceal`).
- `<scrollbox stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>`; `<box border={['left','right']} customBorderChars={…} backgroundColor borderColor position="absolute" zIndex top right/>`; `<text fg bg attributes={TextAttributes.BOLD} selectable={false} wrapMode="word"/>`; `<input placeholder onInput onSubmit focused/>`. Filhos de `<text>` são strings ou `<span>`/`<strong>`.
- Bun: `apps/tui/bunfig.toml` com `preload = ["@opentui/solid/preload"]` no topo e `[test] root = "test"`. O CLI lança `bun --preload @opentui/solid/preload src/main.tsx …` com `cwd = apps/tui` (raiz do pacote) para o preload resolver e o `bunfig.toml` ser o nosso.
- Motion nativo: subclasses de `TextRenderable` com `live = true` e `render(buffer, deltaTime)`; `OptimizedBuffer.create(w, h, ctx.widthMethod, { respectAlpha: true })`, `drawTextBuffer`, `colorMatrix(matrix, mask, 1, TargetChannel.FG)`, `buffer.drawFrameBuffer(x, y, scratch)`.

## Review Focus

1. **Run antigo já sem stream no buffer do daemon.** Abrir a tab mostra os cartões de nós a partir do `RunState` (estado, tentativas, custo) e o `SummaryCard`, sem corpo, sem erro. Teste na Task 8 (`a run without stream shows node cards from state only`).
2. **Aprovação respondida no Telegram enquanto o `ApprovalBar` está visível.** `a` → 409 → toast `Already answered elsewhere`, a barra desaparece na sondagem seguinte e o prompt volta. Teste na Task 9 (`a 409 clears the approval bar on the next tick`).
3. **Daemon cai com três tabs abertas.** Overlay "Connection lost…" após 2 s, nenhuma ação chama o cliente, ao voltar as três subscrições reabrem com `since` = último cursor de cada uma e o overlay some. Teste na Task 5 (`reopens every tab stream with its cursor after the daemon returns`).
4. **Terminal redimensionado de 160 para 80 colunas com sidebar e rail abertos.** Rail passa a horizontal, sidebar fecha, a conversa mantém o scroll no fim, nada transborda a linha inferior. Teste na Task 11 (`resizing from 160 to 80 columns collapses rail and sidebar without overflow`).
5. **Texto de agente com 40 kB em Markdown num único frame.** O cartão renderiza (markdown nativo), o `stickyScroll` mantém o fim, e `k` sobe sem bloquear; conversa limitada a 5.000 cartões com "… N earlier". Teste na Task 8 (`a 40 kB text block renders and the timeline caps at 5000 cards`).

---

## Estrutura de ficheiros

```
apps/tui/package.json, tsconfig.json, bunfig.toml, vitest.config.ts, THIRD_PARTY.md
apps/tui/src/main.tsx                    entrada Bun (dashboard|stream)
apps/tui/src/app.tsx                     runDashboard, runStream, <App/> (providers + rotas)
apps/tui/src/theme/shibaox.json          escalas + tokens
apps/tui/src/theme/resolve.ts            resolveTheme(json) → ResolvedTheme; surface()
apps/tui/src/theme/context.tsx           ThemeProvider, useTheme(), useSyntax()
apps/tui/src/motion/animation.ts         createAnimatable, spring, tween (opencode)
apps/tui/src/motion/one-cell-motion.ts   OneCellMotion, oneCellFrame, WORK_SPINNERS (opencode)
apps/tui/src/motion/subcell.ts           octantGlyph (opencode)
apps/tui/src/motion/pulse.ts             smootherstep, coast, intensityAt, attackDecay (opencode tab-pulse math)
apps/tui/src/motion/masked-text.ts       MaskedTextRenderable (opencode)
apps/tui/src/motion/shimmer-text.tsx     ShimmerText (opencode)
apps/tui/src/motion/fade-in-text.tsx     FadeInText (opencode)
apps/tui/src/motion/spinner.tsx          Spinner (braille), OneCellSpinner, registerSpinner guard
apps/tui/src/motion/config.tsx           MotionProvider, useMotion() → boolean
apps/tui/src/ui/dialog.tsx               DialogProvider, useDialog(), Dialog (opencode)
apps/tui/src/ui/toast.tsx                ToastProvider, useToast(), Toast (opencode)
apps/tui/src/ui/border.ts                EmptyBorder, SplitBorder (opencode)
apps/tui/src/ui/layout.ts                RAIL_WIDTH, SIDEBAR_WIDTH, clampSidebarWidth, railVertical, sidebarAuto
apps/tui/src/ui/marquee.ts               marqueeText (opencode)
apps/tui/src/ui/delayed-presence.ts      createDelayedPresence (opencode)
apps/tui/src/model/status.ts             statusOf (port da 2A-2)
apps/tui/src/model/format.ts             money, duration, age, shortId
apps/tui/src/model/stream.ts             reduceTimeline, Card, Block, summarizeInput
apps/tui/src/model/prompt-commands.ts    parsePromptCommand, completeCommand, PromptContext
apps/tui/src/context/client.tsx          ClientProvider, useClient(), DaemonClientLike
apps/tui/src/context/data.tsx            DataProvider, useData(): stores + Poller
apps/tui/src/context/poller.ts           Poller (port da 2A-2, multi-tab)
apps/tui/src/context/route.tsx           RouteProvider, useRoute(): home | session
apps/tui/src/context/keys.tsx            KeysProvider, useKeys(scope, handler)
apps/tui/src/context/prefs.tsx           loadPrefs/savePrefs + PrefsProvider
apps/tui/src/context/exit.tsx            ExitProvider, useExit()
apps/tui/src/component/logo.tsx          Logo
apps/tui/src/component/prompt/index.tsx  Prompt (input, placeholders, submit)
apps/tui/src/component/prompt/autocomplete.tsx
apps/tui/src/component/footer.tsx        Footer
apps/tui/src/component/tabs.tsx          Tabs (rail vertical / horizontal) + pulse
apps/tui/src/component/sidebar.tsx       Sidebar
apps/tui/src/component/reconnecting.tsx  Reconnecting overlay
apps/tui/src/component/too-small.tsx
apps/tui/src/component/dialogs/runs.tsx, palette.tsx, help.tsx, confirm.tsx, diff.tsx
apps/tui/src/routes/home.tsx
apps/tui/src/routes/session/index.tsx    SessionFrame (header, timeline, bottom, sidebar)
apps/tui/src/routes/session/timeline.tsx
apps/tui/src/routes/session/cards.tsx    NodeCard, ToolLine, GateCard, DecideCard, HumanCard, SummaryCard, ErrorCard
apps/tui/src/routes/session/approval-bar.tsx
apps/tui/src/testing/fake-client.ts      FakeDaemonClient (port da 2A-2 + diff)
apps/tui/test/*.test.tsx, apps/tui/test/boundary.test.ts, apps/tui/test-vitest/*.test.ts
packages/daemon/src/server.ts, run-manager.ts, client.ts   GET /runs/:id/diff, DaemonClient.diff
apps/cli/src/commands/ui.ts               cwd = raiz do apps/tui, --preload
README.md                                 secção Dashboard
```

---

### Task 1: Pacote novo, arranque Solid, fronteira e atribuição

**Files:**
- Delete: tudo em `apps/tui/src`, `apps/tui/test`, `apps/tui/test-bun` (React).
- Create: `apps/tui/package.json`, `apps/tui/tsconfig.json`, `apps/tui/bunfig.toml`, `apps/tui/vitest.config.ts`, `apps/tui/THIRD_PARTY.md`, `apps/tui/src/main.tsx`, `apps/tui/src/app.tsx`, `apps/tui/src/context/client.tsx`, `apps/tui/src/testing/fake-client.ts`
- Modify: `apps/cli/src/commands/ui.ts` (`TUI_ROOT`, `--preload`), `apps/cli/test/follow-any.test.ts` (cwd esperado)
- Test: `apps/tui/test/smoke.test.tsx`, `apps/tui/test/boundary.test.ts`, `apps/cli/test/follow-any.test.ts`

**Interfaces:**
- Produces:

```ts
// package.json
{ "name": "@shibaox/tui", "type": "module", "exports": { ".": "./src/app.tsx" },
  "scripts": { "build": "tsc -p tsconfig.json --noEmit", "test": "vitest run && bun test" },
  "dependencies": { "@opentui/core": "0.5.12", "@opentui/solid": "0.5.12", "solid-js": "1.9.15", "opentui-spinner": "0.0.7", "fuzzysort": "^4.0.2",
                    "@shibaox/core": "workspace:*", "@shibaox/daemon": "workspace:*", "@shibaox/schemas": "workspace:*" },
  "devDependencies": { "@types/bun": "^1.3", "@types/node": "^22", "typescript": "^5.9", "vitest": "^3" } }
// tsconfig.json: extends ../../tsconfig.base.json; jsx "preserve"; jsxImportSource "@opentui/solid"; types ["bun","node"];
//   moduleResolution "bundler"; module "ESNext"; noEmit; include ["src", "test", "test-vitest"]
// bunfig.toml
preload = ["@opentui/solid/preload"]
[test]
root = "test"
preload = ["@opentui/solid/preload"]
// vitest.config.ts: aliases como na 2A-2 ('@shibaox/daemon/client' antes de '@shibaox/daemon'); test.include ['test-vitest/**/*.test.ts']

// src/context/client.tsx
export type DaemonClientLike = Pick<DaemonClient, 'health'|'listRuns'|'getRun'|'events'|'inbox'|'answer'|'cancel'|'resume'|'submitRun'|'diff'>; // diff chega na Task 13: até lá, `diff?: …` opcional
export function ClientProvider(props: ParentProps<{ client: DaemonClientLike }>): JSX.Element;
export function useClient(): DaemonClientLike;

// src/app.tsx
export interface AppOptions { version: string; home: string; cwd?: string; env?: NodeJS.ProcessEnv; renderer?: CliRenderer }
export function runDashboard(client: DaemonClientLike, o: AppOptions): Promise<number>;
export function runStream(client: DaemonClientLike, runId: string, o: AppOptions & { signal?: AbortSignal }): Promise<{ code: number; message?: string }>;
// Nesta task a App desenha só `shibaox · daemon <version>` numa <text>; ctrl+q e ctrl+c (fora de inputs) resolvem 0.

// src/testing/fake-client.ts — port da 2A-2 (runs, states, inboxItems, history, failing, answerError, pushFrame, openStreams, calls) + `diffs: Map<string, DiffResult>` (Task 13)

// apps/cli/src/commands/ui.ts
export const TUI_ROOT = fileURLToPath(new URL('../../../tui/', import.meta.url));      // raiz do pacote
export const TUI_ENTRY = join(TUI_ROOT, 'src/main.tsx');
export const TUI_ARGS = ['--preload', '@opentui/solid/preload'];
spawn('bun', [...TUI_ARGS, TUI_ENTRY, ...args], { stdio: 'inherit', cwd: TUI_ROOT, env });
```

- [ ] **Step 1: Testes a falhar**
  - `test/smoke.test.tsx`: `testRender(() => <App client={fake} version="0.0.1" home="/tmp/h" env={{SHIBAOX_NO_MOTION:'1'}} onExit={…}/>, { width: 80, height: 20 })` → `captureCharFrame()` contém `shibaox · daemon 0.0.1`; `mockInput.pressKey('q', { ctrl: true })` → `onExit(0)`.
  - `test/boundary.test.ts` (port): `bun -e` que importa `src/app.tsx` com o preload e afirma que `require.cache`/`Loader.registry` não tem `better-sqlite3|persistence-sqlite|run-manager|adapter-claude-code`.
  - `apps/cli/test/follow-any.test.ts`: `tuiSpawnOptions().cwd` termina em `apps/tui` e os args começam por `['--preload','@opentui/solid/preload']`.
- [ ] **Step 2: Ver falhar** (`bun test` em `apps/tui` falha por `App` inexistente; vitest do CLI falha na asserção do cwd).
- [ ] **Step 3: Implementar**: apagar o React, escrever os ficheiros acima, `pnpm install`, `THIRD_PARTY.md` com o texto MIT do opencode e a lista (vazia por agora, cresce nas Tasks 3 e 6).
- [ ] **Step 4: Ver passar**: `cd apps/tui && bun test && npx tsc -p tsconfig.json --noEmit`; `pnpm --filter @shibaox/cli test`; e um arranque real: `bun --preload @opentui/solid/preload src/main.tsx dashboard --socket /nonexistent --home /tmp/h --version 0.0.1` num pty de 80×24 mostra o título e sai com `ctrl+q`.
- [ ] **Step 5: Commit** `feat(tui): restart apps/tui on @opentui/solid with the CLI spawn and boundary test`.

---

### Task 2: Tema semântico

**Files:**
- Create: `apps/tui/src/theme/shibaox.json`, `apps/tui/src/theme/resolve.ts`, `apps/tui/src/theme/context.tsx`
- Test: `apps/tui/test-vitest/theme.test.ts`, `apps/tui/test/theme-context.test.tsx`

**Interfaces:**
- Produces:

```ts
// shibaox.json (esquema)
{ "hue": { "neutral": { "100": "#f8f3ec", "200": "#f1e9df", "300": "#d9cdbf", "400": "#b9a694", "500": "#8f7d6d", "600": "#37302b", "700": "#2c2622", "800": "#231e1b", "900": "#1a1614" },
           "interactive": { "100": "#ffc79a", "200": "#ffa15c", "300": "#e8853d", … }, "green": {…"200": "#6acb8e"}, "red": {…"200": "#ff7a8a"}, "yellow": {…"200": "#f2c150"}, "cyan": {…"200": "#7fd3e6"}, "blue": {…"200": "#86aef5"}, "purple": {…}, "orange": {…} },
  "text": { "base": "$hue.neutral.200", "muted": "$hue.neutral.400",
            "action": { "primary": { "base": "$text.base", "focused": "$hue.neutral.900", "selected": "$hue.interactive.200", "disabled": "$hue.neutral.500" } },
            "feedback": { "error": "$hue.red.200", "warning": "$hue.yellow.200", "success": "$hue.green.200", "info": "$hue.cyan.200", "running": "$hue.blue.200" } },
  "background": { "base": "$hue.neutral.900", "raised": { "base": "$hue.neutral.800", "high": "$hue.neutral.700", "max": "$hue.neutral.600" },
                  "action": { "primary": { "hovered": "$hue.neutral.700", "focused": "$hue.interactive.200", "selected": "$hue.neutral.600" } },
                  "feedback": { "error": "#3a2226", "warning": "#3a3220", "success": "#203a2a", "info": "#203238", "running": "#22283a" } },
  "border": { "base": "$hue.neutral.600" }, "scrollbar": { "base": "$hue.neutral.600" },
  "diff": { "added": "$hue.green.200", "removed": "$hue.red.200", "addedBg": "#203a2a", "removedBg": "#3a2226" },
  "syntax": { "keyword": "$hue.interactive.200", "string": "$hue.green.200", "comment": "$hue.neutral.400", "function": "$hue.blue.200", "type": "$hue.cyan.200", "number": "$hue.yellow.200", "heading": "$hue.interactive.200", "link": "$hue.cyan.200" } }

// resolve.ts
export type Feedback = 'error'|'warning'|'success'|'info'|'running';
export interface ResolvedTheme {
  text: { base: RGBA; muted: RGBA; action: { primary: { base: RGBA; focused: RGBA; selected: RGBA; disabled: RGBA } }; feedback: Record<Feedback, RGBA> };
  background: { base: RGBA; raised: { base: RGBA; high: RGBA; max: RGBA }; action: { primary: { hovered: RGBA; focused: RGBA; selected: RGBA } }; feedback: Record<Feedback, RGBA> };
  border: { base: RGBA }; scrollbar: { base: RGBA };
  diff: { added: RGBA; removed: RGBA; addedBg: RGBA; removedBg: RGBA };
  syntax: Record<'keyword'|'string'|'comment'|'function'|'type'|'number'|'heading'|'link', RGBA>;
  surface(name: 'dialog'|'sidebar'|'toast'): ResolvedTheme;   // base ← raised.base; raised.base ← raised.high; raised.high ← raised.max
}
export function resolveTheme(json: unknown): ResolvedTheme;    // referências `$a.b.c` resolvidas recursivamente; ciclo ou chave em falta → Error('theme: unresolved <ref>')
export function syntaxStyles(t: ResolvedTheme): Record<string, StyleDefinitionInput>; // nomes da nota OpenTUI acima
// context.tsx
export function ThemeProvider(props: ParentProps<{ theme?: ResolvedTheme }>): JSX.Element;  // default: resolveTheme(shibaox.json)
export function useTheme(): ResolvedTheme;
export function useSyntax(): SyntaxStyle;                       // SyntaxStyle.fromStyles(syntaxStyles(theme)), memoizado por tema
```

- [ ] **Step 1: Testes a falhar**: `resolveTheme` devolve `text.base` = RGBA de `#f1e9df`; `$text.base` encadeado resolve; referência em falta lança `theme: unresolved $hue.pink.200`; `surface('dialog').background.base` = `raised.base` do base; `syntaxStyles` tem `markup.heading` com `bold: true`. `theme-context`: um componente que lê `useTheme().text.base` renderiza.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar (`vitest` + `bun test`).
- [ ] **Step 5: Commit** `feat(tui): semantic theme resolved from shibaox.json with surfaces and syntax styles`.

---

### Task 3: Primitivas de motion

**Files:**
- Create: `apps/tui/src/motion/animation.ts`, `one-cell-motion.ts`, `subcell.ts`, `pulse.ts`, `masked-text.ts`, `shimmer-text.tsx`, `fade-in-text.tsx`, `spinner.tsx`, `config.tsx`; `apps/tui/src/ui/delayed-presence.ts`, `apps/tui/src/ui/marquee.ts`
- Modify: `apps/tui/THIRD_PARTY.md` (listar os copiados)
- Test: `apps/tui/test-vitest/motion.test.ts` (puros), `apps/tui/test/motion.test.tsx` (renderables)

**Interfaces:**
- Produces (assinaturas iguais ao opencode; `useConfig().data.animations` substituído por `useMotion()`):

```ts
export function spring(o: { visualDuration: number; restDelta?: number; restSpeed?: number }): Transition;
export function tween(o: { duration: number; ease?: (p: number) => number }): Transition;
export function createAnimatable<T extends Record<string, number | readonly number[]>>(initial: T, o: { transition: Transition; enabled?: Accessor<boolean> }): { value: Accessor<T>; animate(next: T): void; jump(next: T): void; stop(): void };
export type OneCellMotion = { frames: string[]; interval: number; levels?: number[]; intro?: …; once?: boolean; pace?: … };
export function oneCellFrame(a: OneCellMotion, elapsed: number): { glyph: string; level: number; complete: boolean };
export const WORK_SPINNERS: Record<'block-soft-sweep'|'block-soft-slide'|'block-low-comet'|'seed', OneCellMotion>;
export function octantGlyph(mask: number): string;
export const smootherstep, coast, intensityAt, attackDecay, completionPulseOpacity;   // pulse.ts
export class MaskedTextRenderable extends TextRenderable { protected renderMasked(buffer, initialStrength, shade): void }
export function ShimmerText(props: TextProps & { shimmer: RGBA }): JSX.Element;         // <shimmer_text>
export function FadeInText(props: TextProps & { animate?: boolean; backdrop?: RGBA }): JSX.Element; // <fade_in_text>; animate ∧ useMotion()
export function Spinner(props: { children?: JSX.Element; color?: RGBA; shimmer?: RGBA }): JSX.Element;  // braille 80 ms; sem motion → `⋯`
export function OneCellSpinner(props: { animation: OneCellMotion; color: ColorInput; paused?: boolean; still?: string }): JSX.Element; // sem motion → still ?? '▪'
export function MotionProvider(props: ParentProps<{ enabled: boolean }>): JSX.Element;
export function useMotion(): Accessor<boolean>;
export function createDelayedPresence<T>(source: Accessor<T|undefined>, delay: number | ((v: T) => number)): Accessor<boolean>;
export function marqueeText(value: string, width: number, offset: number): string;
```

- [ ] **Step 1: Testes a falhar** (vitest): `oneCellFrame(WORK_SPINNERS['block-soft-sweep'], 0).glyph` é um glifo octante e `complete === false`; `oneCellFrame(SEED_LAUNCH, 10_000).complete === true`; `octantGlyph(0xff) === '█'`; `coast(0) === 0`, `coast(1) === 1`, `intensityAt(5, 5, 4, 18) === 1`; `marqueeText('hello-feature', 8, 0) === 'hello-fe'` e com offset 3 começa em `lo-`; `createAnimatable({w:10},{transition: spring({visualDuration:.2}), enabled: () => false}).animate({w:20})` → `value().w === 20` imediatamente. (bun test) `ShimmerText` e `FadeInText` renderizam o texto (`captureCharFrame` contém `Working`) com e sem motion; `Spinner` sem motion desenha `⋯`; `OneCellSpinner` sem motion desenha `▪`.
- [ ] **Step 2–4:** ver falhar, copiar/adaptar, ver passar. Os renderables custom precisam de `extend` + augmentação de módulo antes do primeiro `testRender`.
- [ ] **Step 5: Commit** `feat(tui): motion primitives adapted from opencode (springs, one-cell spinners, shimmer, fade-in)`.

---

### Task 4: Modelo puro: estado, formato, redução de frames em cartões, comandos do prompt

**Files:**
- Create: `apps/tui/src/model/status.ts`, `format.ts`, `stream.ts`, `prompt-commands.ts`
- Test: `apps/tui/test-vitest/status.test.ts`, `format.test.ts`, `stream.test.ts`, `prompt-commands.test.ts`

**Interfaces:**
- Produces:

```ts
// status.ts (port da 2A-2)
export type StatusWord = 'Working'|'Needs you'|'Queued'|'Done'|'Failed'|'Paused'|'Cancelled';
export function statusOf(run: { status: string }): { word: StatusWord; symbol: string; feedback: Feedback | 'muted' };
// format.ts
export const money = (usd: number) => string;          // $0.0020 (4 casas < $1, 2 casas ≥ $1)
export const duration = (ms: number) => string;        // 41 s · 2m 13s · 1h 04m
export const age = (iso: string, now?: number) => string; // 12 s · 3 m · 2 h · 4 d
export const shortId = (id: string) => string;         // 8 chars
// stream.ts
export type Block =
  | { kind: 'text'; text: string; parentId?: string }
  | { kind: 'tool'; id: string; name: string; summary: string; input: unknown; output?: unknown; ms?: number; status: 'running'|'done'|'error'; parentId?: string }
  | { kind: 'file'; path: string };
export type Card =
  | { kind: 'node'; nodeId: string; type: 'task'|'code'; role?: string; runtime?: string; status: NodeStatus; attempts: number; costUsd?: number; startedAt?: string; endedAt?: string; blocks: Block[]; tools: number }
  | { kind: 'gate'; nodeId: string; status: NodeStatus; checks: { name: string; passed: boolean; ms?: number; message?: string }[]; passed?: boolean; report?: string }
  | { kind: 'decide'; nodeId: string; status: NodeStatus; choice?: string; confidence?: number }
  | { kind: 'human'; nodeId: string; prompt: string; action?: string; pending: boolean; answer?: { approved: boolean; note?: string; via?: string; at: string } }
  | { kind: 'error'; nodeId?: string; message: string }
  | { kind: 'earlier'; count: number }
  | { kind: 'summary'; status: RunStatus; costUsd: number; durationMs?: number; files: string[]; branch?: string; error?: string };
export const CARD_LIMIT = 5000;
export function reduceTimeline(state: RunState | undefined, frames: Envelope[]): Card[];
export function summarizeInput(input: unknown, limit?: number): string;  // "src/a.ts" para {file_path}, "git push" para {command}, senão JSON aparado a 80
export const RUN_EVENT_REFRESH: ReadonlySet<string>;
// prompt-commands.ts
export interface PromptContext { org: string; project: string; workflow?: string; adapter: 'mock'|'claude-code'|'direct'; budgetUsd?: number; workspace?: 'inplace'|'worktree' }
export const COMMANDS = ['workflow','project','org','adapter','budget','workspace','runs','help'] as const;
export function parsePromptCommand(text: string): { command: typeof COMMANDS[number]; arg: string } | undefined; // '/workflow hello' → {command:'workflow', arg:'hello'}
export function completeCommand(text: string, ctx: { workflows: string[] }): { label: string; insert: string }[]; // fuzzysort sobre comandos e, para /workflow, sobre workflows
export function applyPromptCommand(ctx: PromptContext, cmd: { command; arg }, o: { cwd: string }): PromptContext | { error: string }; // expande ~, valida adapter/budget
export function toSubmitRequest(ctx: PromptContext, input: string): SubmitRequest;
```

Regras de `reduceTimeline`: ordem dos cartões = ordem de `NodeStarted` no log (frames `run`), com o `workflowSnapshot` a dar o `type`/`role`/`runtime` do nó; sem frames, um cartão por nó do `state.nodes` na ordem do snapshot (`start` primeiro, depois `next` em largura). Frames `runtime` juntam-se ao cartão `node` do seu `nodeId`: `text` concatena ao último bloco `text` com o mesmo `parentId`; `tool_use` cria bloco `tool` (`status running`); `tool_result` com o mesmo `id` (ou o último `running` do mesmo `name`) fecha-o com `output`/`ms`; `file_changed` cria `file`; `result` fecha o cartão; `error` cria `error`. `GatePassed/Failed` preenchem o `gate` (`report` = mensagens dos checks falhados juntas por `\n`), `DecisionMade` o `decide`, `HumanRequested/Responded` o `human` (`pending` = está em `state.pendingHumans`), `NodeCompleted/Failed` fecham (`costUsd` = `cost.usd`), `RunCompleted/Cancelled`/`end`/`state.status` terminal → `summary` (`files` = paths únicos de `file_changed`; `branch` = `state.branch`; `durationMs` entre `RunStarted` e o último frame). Mais de `CARD_LIMIT` → os mais antigos viram `{ kind: 'earlier', count }`.

- [ ] **Step 1: Testes a falhar**: `statusOf` (7 estados); `money(0.002) === '$0.0020'`, `money(1.5) === '$1.50'`, `duration(41_000) === '41 s'`, `duration(133_000) === '2m 13s'`; `age`; `reduceTimeline`: (a) task com text+tool_use+tool_result+file_changed → 1 `node` com 3 blocos e `tools === 1`, `ms === 7`; (b) gate falhado → `gate` com `passed false` e `report`; (c) `DecisionMade` → `decide` com choice/confidence; (d) `HumanRequested` sem resposta e `state.pendingHumans` → `pending true`; (e) `end` completed → último cartão `summary` com `files` únicos e `branch`; (f) **Review Focus 1**: `frames = []` e `state.nodes` com 5 nós → 5 cartões `node` sem blocos + `summary`; (g) 5.100 frames `text` em nós distintos → `cards[0].kind === 'earlier'` e `cards.length === CARD_LIMIT + 1`; `summarizeInput({file_path:'src/a.ts'}) === 'src/a.ts'`; `parsePromptCommand('/workflow hello')`, `completeCommand('/wor', {workflows:['hello-feature']})[0].insert === '/workflow '`, `completeCommand('/workflow hel', …)[0].insert === '/workflow hello-feature'`, `applyPromptCommand(ctx, {command:'budget', arg:'abc'}, …)` → `{ error: 'Budget must be a number' }`, `applyPromptCommand(ctx, {command:'project', arg:'~/x'}, …).project === join(homedir(), 'x')`.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar (`vitest`).
- [ ] **Step 5: Commit** `feat(tui): pure model — status, formatting, timeline reduction and prompt commands`.

---

### Task 5: Contextos: dados + poller multi-tab, rotas, teclas por scope, prefs, exit

**Files:**
- Create: `apps/tui/src/context/data.tsx`, `poller.ts`, `route.tsx`, `keys.tsx`, `prefs.tsx`, `exit.tsx`
- Test: `apps/tui/test-vitest/poller.test.ts`, `apps/tui/test/keys.test.tsx`

**Interfaces:**
- Produces:

```ts
// data.tsx
export interface DataState {
  health?: Health; reachable: boolean; unreachableSince?: number;
  runs: RunSummaryPlus[]; inbox: InboxItem[];
  states: Record<string, RunState>; frames: Record<string, Envelope[]>; ended: Record<string, RunStatus>;
  open: string[]; active?: string;                          // tabs; active undefined = home
  unread: Record<string, 'done'|'needs'>;                   // pulses pendentes por run
}
export interface Data {
  state: DataState;                                          // store Solid (leitura reativa)
  timeline(runId: string): Accessor<Card[]>;                 // memo por run sobre reduceTimeline
  openRun(runId: string): void; closeRun(runId: string): void; activate(runId?: string): void; nextTab(d: 1|-1): void;
  markRead(runId: string): void;
  actions: { answer(id: InboxId, approved: boolean, note?: string): Promise<void>; cancel(runId): Promise<void>; resume(runId, budgetUsd?): Promise<void>; submit(req: SubmitRequest): Promise<string|undefined> };
  poller: Poller;
}
export function DataProvider(props: ParentProps<{ client: DaemonClientLike; intervals?: Partial<PollerIntervals>; now?: () => number }>): JSX.Element;
export function useData(): Data;
// poller.ts (port da 2A-2; a diferença é `subscribe(runId)`/`unsubscribe(runId)` por tab e o cursor por run)
export class Poller { constructor(o: { client; set: SetStoreFunction<DataState>; get: () => DataState; toast: (t: {message; variant}) => void; now?; intervals? });
  start(): void; stop(): void; tick(): Promise<void>; healthTick(): Promise<void>;
  subscribe(runId: string): void; unsubscribe(runId: string): void; refreshRun(runId: string): Promise<void>;
  answer(id, approved, note?): Promise<void>; cancel(runId): Promise<void>; resume(runId, budgetUsd?): Promise<void>; submit(req): Promise<string|undefined>; }
// unread: quando um run aberto mas não ativo recebe `end` → unread[run]='done'; quando ganha pendingApprovals/pendingHumans → 'needs'; toast com ação Open.
// route.tsx
export type Route = { type: 'home' } | { type: 'session'; runId: string };
export function RouteProvider(props: ParentProps<{ initial?: Route }>): JSX.Element;
export function useRoute(): { data: Accessor<Route>; navigate(r: Route): void };
// keys.tsx
export type Scope = 'global'|'pane'|'prompt'|'dialog';
export type KeyHandler = (key: KeyEvent) => boolean | void;   // true = consumido
export function KeysProvider(props: ParentProps<{ onExit: (code: number) => void }>): JSX.Element;
export function useKeys(scope: Scope, handler: KeyHandler): void;   // regista no mount, remove no cleanup
// Despacho: ctrl+q → onExit(0) sempre. Depois, se há handlers 'dialog': só o último recebe (modal). Senão: 'prompt' (último) → 'pane' (último) → 'global' (todos, por ordem inversa) até um devolver true. ctrl+c: se um handler 'prompt' o consome (limpar texto) fica por aí; senão onExit(0).
// prefs.tsx
export interface Prefs { lastOrg?: string; lastAdapter?: string; lastWorkflow?: string; animations?: boolean; sidebarWidth?: number; sidebar?: 'auto'|'hide' }
export function loadPrefs(home: string): Prefs; export function savePrefs(home: string, p: Prefs): void;   // ~/.shibaox/ui.json, try/catch
export function PrefsProvider(props: ParentProps<{ home: string }>): JSX.Element; export function usePrefs(): { data: Prefs; update(patch: Partial<Prefs>): void };
// exit.tsx
export function ExitProvider(props: ParentProps<{ onExit: (code: number) => void }>): JSX.Element; export function useExit(): (code: number) => void;
```

- [ ] **Step 1: Testes a falhar** (vitest, `FakeDaemonClient`, fake timers): `tick` preenche `runs`/`inbox`; `failing` → `reachable false` e delay `slow`; `subscribe('a')`+`subscribe('b')` → `openStreams()` = `['a','b']`, `unsubscribe('a')` → `['b']`; frames chegam a `frames.a` e `frames.b` sem cruzar; **Review Focus 3** (`reopens every tab stream with its cursor after the daemon returns`): 3 subscrições, `failing=true` fecha as 3, `failing=false` + `tick` reabre as 3 e `calls` mostra `events(runId, { since: <último cursor> })`; `end` num run não ativo → `unread[run] === 'done'` e toast com `action.label === 'Open'`; `answer` 409 → toast `Already answered elsewhere`; `stop()` → sem streams nem timers. (bun test) `keys`: um `dialog` ativo engole `j` (o `pane` não recebe); sem diálogo `pane` recebe `j` e `global` recebe `?`; `ctrl+q` chama `onExit(0)` mesmo com diálogo; `ctrl+c` com handler de prompt que devolve `true` não sai; sem ele sai.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): data stores with a multi-tab poller, routes, scoped keys, prefs and exit`.

---

### Task 6: Diálogos, toasts, bordas e layout

**Files:**
- Create: `apps/tui/src/ui/dialog.tsx`, `toast.tsx`, `border.ts`, `layout.ts`; `apps/tui/src/component/reconnecting.tsx`, `too-small.tsx`
- Modify: `apps/tui/THIRD_PARTY.md`
- Test: `apps/tui/test/dialog-toast.test.tsx`, `apps/tui/test-vitest/layout.test.ts`

**Interfaces:**
- Produces:

```ts
export type DialogSize = 'medium'|'large'|'xlarge'; export function dialogWidth(s: DialogSize): 60|88|116;
export function Dialog(props: ParentProps<{ size?: DialogSize; centered?: boolean; onClose: () => void; title?: string }>): JSX.Element; // backdrop rgba(0,0,0,150), fundo surface('dialog'), título em bold na 1.ª linha
export function DialogProvider(props: ParentProps): JSX.Element;
export function useDialog(): { open(el: () => JSX.Element, o?: { onClose?: () => void }): void; close(): void; clear(): void; depth: Accessor<number> };
// O DialogProvider regista useKeys('dialog') enquanto depth() > 0: esc → close(); todas as outras teclas vão ao diálogo do topo via o seu próprio useKeys('dialog') (registado depois, logo é o último).
export interface ToastOptions { title?: string; message: string; variant: Feedback; duration?: number; action?: { label: string; run: () => void } }
export function ToastProvider(props: ParentProps): JSX.Element; export function Toast(): JSX.Element;
export function useToast(): { show(t: ToastOptions): void; error(e: unknown): void; pending: Accessor<number>; current: Accessor<ToastOptions|undefined>; activate(): void };
export const EmptyBorder, SplitBorder;                       // border.ts (opencode)
export const RAIL_WIDTH = 20, RAIL_BREAKPOINT = 106, SIDEBAR_WIDTH = 42, SIDEBAR_MIN = 24, SIDEBAR_MAX = 72, CONTENT_MIN = 44, MIN_COLS = 60, MIN_ROWS = 15;
export function railVertical(width: number): boolean;        // width >= 106
export function sidebarAuto(width: number, rail: number): boolean; // width - rail >= 120
export function clampSidebarWidth(w: number, total: number): number; // max(24, min(w, 72, total - 44))
export function Reconnecting(props: { since: Accessor<number|undefined> }): JSX.Element; // createDelayedPresence 2000 ms; overlay zIndex 10000
export function TooSmall(): JSX.Element;
```

- [ ] **Step 1: Testes a falhar**: (bun) `useDialog().open(() => <text>Hi</text>)` → frame contém `Hi` e o texto de fundo continua visível mas escurecido (`captureCharFrame` contém ambos); `pressEscape` fecha (`depth() === 0`); dois abertos, `esc` fecha só o topo; `useToast().show({message:'Run done', variant:'success'})` → frame contém `Run done` no canto (coluna > width/2); segundo toast → `+1 more`; `duration` expira; `action` com `mockMouse.click` na linha do toast chama `run`. (vitest) `railVertical(105) === false`, `railVertical(106) === true`; `sidebarAuto(140, 20) === true`, `sidebarAuto(125, 20) === false`; `clampSidebarWidth(100, 140) === 72`, `clampSidebarWidth(10, 140) === 24`.
- [ ] **Step 2–4:** ver falhar, copiar/adaptar (`useTheme().surface('dialog')`), ver passar.
- [ ] **Step 5: Commit** `feat(tui): dialog stack, toasts, split borders and layout rules`.

---

### Task 7: Home: logo, prompt com comandos, footer

**Files:**
- Create: `apps/tui/src/component/logo.tsx`, `prompt/index.tsx`, `prompt/autocomplete.tsx`, `footer.tsx`, `apps/tui/src/routes/home.tsx`
- Test: `apps/tui/test/home.test.tsx`

**Interfaces:**
- Produces:

```ts
export function Logo(): JSX.Element;    // ASCII 5 linhas "shibaox" (≥ 44 col) ou 3 linhas (< 44), sombra tint(background.base, interactive, .25); escondido se height < 12
export interface PromptRef { focus(): void; set(text: string): void; current(): string; clear(): void }
export function Prompt(props: { ref?: (r: PromptRef) => void; placeholders: string[]; disabled?: boolean; workflows: string[]; onSubmit(text: string): void; onCommand(cmd: { command; arg }): void }): JSX.Element;
// <input> com borda superior `─` em interactive quando focado; placeholder roda a cada 4 s (só com motion); `/` abre o autocomplete (lista de até 6 sugestões acima do input, ↑/↓ escolhem, tab/enter inserem); enter com `/cmd` → onCommand; enter com texto → onSubmit; ctrl+c com texto → clear (consome); ctrl+c vazio → não consome (sai).
export function Footer(props: { left: string; right: string }): JSX.Element;  // 1 linha, muted, right alinhado à direita; marquee no left se não couber
export function Home(): JSX.Element;
// Contexto (PromptContext) inicial: org = prefs.lastOrg ?? join(cwd,'org'); project = cwd; adapter = prefs.lastAdapter ?? 'mock'; workflow = prefs.lastWorkflow; workflows via loadOrg(org) (erro → linha vermelha "Org not found: <path>" e submit bloqueado). Linha de contexto sob o prompt: `org demo/org · workflow hello-feature · project demo/project · adapter mock` (basenames; budget se definido). Submit: toast `Run <id8> queued`, prefs guardadas, `data.openRun(id)`, `navigate({type:'session', runId})`.
// Footer: left = `daemon <version> · <running> running · <queued> queued[ · ▲ <n> needs you]` ou `Daemon unreachable`; right = `ctrl+o runs · ctrl+k commands · ? help`.
```

- [ ] **Step 1: Testes a falhar** (`scaffoldOrg` em tmp como na 2A-2; `cwd` = tmp): frame mostra o logo (contém `shibaox` ou os blocos `█`), o placeholder, a linha de contexto com `workflow hello-feature` e o footer com `daemon 0.0.1`; `typeText('/wor')` → sugestão `/workflow`; `pressTab` insere `/workflow `; `typeText('hel')` + `pressEnter` → contexto passa a `hello-feature`; `typeText('add /health')` + `pressEnter` → `client.calls` tem `submitRun` com `{orgRoot, project: tmp, workflow:'hello-feature', input:'add /health', adapter:'mock'}`, `loadPrefs(home).lastWorkflow === 'hello-feature'`, rota = session; `/budget abc` → linha `Budget must be a number`; org inválido (`/org /nope`) → `Org not found` e enter não submete; `ctrl+c` com texto limpa, `ctrl+c` vazio chama `onExit(0)`; `resize(40, 10)` esconde o logo sem erro.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): home with logo, command prompt and daemon footer`.

---

### Task 8: Sessão: header, timeline e cartões

**Files:**
- Create: `apps/tui/src/routes/session/index.tsx`, `timeline.tsx`, `cards.tsx`
- Test: `apps/tui/test/session.test.tsx`

**Interfaces:**
- Produces:

```ts
export function SessionFrame(props: { runId: string; single?: boolean }): JSX.Element; // single = modo stream (sem tabs/sidebar). Header 1 linha (raised): `<id8> · <workflow> · <symbol> <word> · <money> · <duration>`; word em ShimmerText enquanto Working. Corpo: <Timeline/>. Fundo: <ApprovalBar/> (Task 9) ou linha de atalhos.
export function Timeline(props: { runId: string; expanded: Set<string>; onToggle(id: string): void; focused: boolean }): JSX.Element; // scrollbox stickyScroll bottom; cards do useData().timeline(runId); cada cartão com FadeInText na 1.ª linha; selected index para enter
export function NodeCard(props: { card: Card & {kind:'node'}; expanded: Set<string>; onToggle }): JSX.Element;
//   header: `<spinner|symbol> <nodeId> · <role> · <runtime> · <n> tools · <money> · <duration>`; blocos: text → <markdown streaming={status==='running'}>, tool → <ToolLine>, file → `± path`
export function ToolLine(props: { block: Block & {kind:'tool'}; expanded: boolean; onToggle }): JSX.Element; // `> Read src/a.ts · 7 ms · done`; expandido: input resumido + output em <code filetype="text"> (aparado a 4096)
export function GateCard, DecideCard, HumanCard, ErrorCard, SummaryCard, EarlierCard;
```

- [ ] **Step 1: Testes a falhar** (fake com `history` de frames; `SHIBAOX_NO_MOTION`): run a correr com text+tool_use+tool_result → frame contém `analyse`, `> Read src/a.ts`, `7 ms`, o texto do agente; `pressEnter` na tool expande (contém `ok` do output); gate falhado → `✗ qa` e o relatório; `DecisionMade` → `judge → ship (0.91)`; run completed → `✓ Done · 5 nodes · $0.0020` e `4 files changed`; **Review Focus 1** (`a run without stream shows node cards from state only`): `history` vazio, state com 5 nós → 5 cabeçalhos e o summary; **Review Focus 5** (`a 40 kB text block renders and the timeline caps at 5000 cards`): frame `text` de 40 kB → renderiza (frame contém o início do texto após scroll ao topo com `pressKey('g')`) e 5.100 nós → `… 100 earlier`; header contém `Working` para running e `Done` para completed.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): session view — header, timeline and cards per node type`.

---

### Task 9: Aprovações inline e teclas da sessão

**Files:**
- Create: `apps/tui/src/routes/session/approval-bar.tsx`, `apps/tui/src/component/dialogs/confirm.tsx`
- Modify: `apps/tui/src/routes/session/index.tsx`
- Test: `apps/tui/test/session-keys.test.tsx`

**Interfaces:**
- Produces:

```ts
export function ApprovalBar(props: { runId: string }): JSX.Element; // items = inbox filtrado por runId (approval primeiro); `▲ <prompt> · <role|action> · [a]pprove [d]eny [n]ote`; approval-kind pede `y` (`Approve <command>? (y/n)`); `n` abre <input> para a nota e enter responde approved=true com note; esc cancela
export function Confirm(props: { message: string; onYes: () => void; onNo: () => void }): JSX.Element; // Dialog medium centered, `y`/`n`/esc
// Teclas da sessão (useKeys('pane'), só quando a conversa tem foco): j/k/↑/↓ scroll 1, pgup/pgdn página, g topo, G fim, enter expande/colapsa o cartão/tool selecionado, d → diff (Task 13) salvo com pendente (d = deny), c → Confirm('Cancel run <id8>?') → actions.cancel, r → actions.resume se status paused_budget (toast `Nothing to resume` senão), tab → foco sidebar (Task 11).
```

- [ ] **Step 1: Testes a falhar**: inbox com human para o run → barra visível; `a` → `answer(id, {approved:true, via:'cli'})`; approval-kind: `a` mostra `Approve git push origin main?`, `y` responde; `d` responde `approved:false`; `n` + `typeText('looks fine')` + enter → `note:'looks fine'`; **Review Focus 2** (`a 409 clears the approval bar on the next tick`): `answerError 409` → toast `Already answered elsewhere`, `inboxItems=[]` + `poller.tick()` → barra some e a linha de atalhos volta; `c` → `Cancel run aaaa1111?`, `y` → `cancel('aaaa1111-x')`; `r` num run running → toast `Nothing to resume`; sem pendente `d` não responde a nada (chama o diff da Task 13: até lá, `d` sem pendente é no-op testado como "não chama answer").
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): inline approvals and session keys`.

---

### Task 10: App shell: rotas, tabs com pulse, atalhos globais

**Files:**
- Create: `apps/tui/src/component/tabs.tsx`
- Modify: `apps/tui/src/app.tsx` (providers: Client → Prefs → Motion → Theme → Keys → Exit → Toast → Dialog → Data → Route; `<Shell/>` com Tabs + rota + Toast + Reconnecting + TooSmall)
- Test: `apps/tui/test/shell.test.tsx`

**Interfaces:**
- Produces:

```ts
export function Tabs(props: { vertical: boolean }): JSX.Element;
// vertical (20 col, raised): `⌂ home` + uma linha por run aberto `<symbol> <id8>` + 2.ª linha muted `<workflow>` (marquee); ativo com fundo action.selected e barra `┃` interactive; horizontal (1 linha): `⌂ · ● fe4a4950 · ✓ 21ae8405 …`. Pulse: run em `unread` recebe 3 pulsos (completionPulseOpacity sobre 1.2 s, via createAnimatable tween) e mantém `•` até activate() (markRead). Click seleciona.
// Shell: useKeys('global'): ctrl+n → home; ctrl+o → RunsDialog (Task 12); ctrl+k → Palette (Task 12); ctrl+b → sidebar (Task 11); ctrl+] / ctrl+[ → nextTab(±1); ctrl+w → closeRun(active); ? → Help (Task 12) quando nenhum input tem foco.
// Reconnecting quando `!state.reachable` há > 2 s; TooSmall quando width < 60 || height < 15 (substitui tudo).
// runDashboard: monta <App/> com renderer próprio; resolve quando onExit é chamado (renderer.destroy() antes). runStream: RouteProvider initial session, `single`, resolve `{code}` quando `ended[runId]` (0 completed, 2 failed/cancelled) ou `{code:0, message:'Run <id> keeps running. Follow it with: shibaox follow <id>'}` em q/ctrl+c/signal.
```

- [ ] **Step 1: Testes a falhar**: com 2 runs abertos e width 160 → rail vertical contém `⌂ home`, ambos os ids e o workflow; width 100 → linha horizontal; `ctrl+]` muda `active`; `ctrl+w` fecha; `ctrl+n` volta à home; run não ativo recebe `end` → tab mostra `•` e, após `markRead`, deixa de mostrar; `mockMouse.click` na tab ativa-a; `failing=true` + avançar 2,5 s → frame contém `Connection lost`; `resize(50, 10)` → `Terminal too small`; `runStream` com `end` completed resolve `{code:0}`, `failed` → 2, abort → `keeps running`.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): app shell with tabs, pulses, global keys and stream mode`.

---

### Task 11: Sidebar com spring e redimensionamento

**Files:**
- Create: `apps/tui/src/component/sidebar.tsx`, `apps/tui/src/ui/pane-resize.ts` (opencode `createPaneResize`, adaptado)
- Modify: `apps/tui/src/routes/session/index.tsx`
- Test: `apps/tui/test/sidebar.test.tsx`

**Interfaces:**
- Produces:

```ts
export function Sidebar(props: { runId: string; width: number; focused: boolean; onFocusBack(): void }): JSX.Element;
// blocos: `Runs` (Today / Yesterday / Earlier por createdAt; linha `<symbol> <id8> <workflow> <age>`; j/k selecionam, enter openRun+activate, a/d respondem se o run selecionado tem pendente), `Needs you` (inbox de todos os runs), `This run` (files do summary/blocos file, custo por nó `<nodeId> <money>`).
export function createPaneResize(o: { value: Accessor<number>; clamp(w: number): number; onCommit(w: number): void; fromMouse(e: MouseEvent): number }): { width: Accessor<number>; hovered; resizing; onMouseOver; onMouseOut; onMouseDown; onMouseMove; onMouseUp };
// SessionFrame: sidebarVisible = prefs.sidebar !== 'hide' && sidebarAuto(width, rail) || openedByKey; largura animada com createAnimatable({w}, spring .25 s); ctrl+b alterna (guarda prefs.sidebar); tab alterna foco conversa ↔ sidebar; handle de 1 col à esquerda da sidebar arrastável (drag altera prefs.sidebarWidth com clampSidebarWidth).
```

- [ ] **Step 1: Testes a falhar**: width 160 → sidebar visível com `Runs`, `Today`, os dois runs, `Needs you (1)`; width 120 (rail 20 → 100 < 120) → escondida; `ctrl+b` mostra e `prefs.sidebar === 'auto'`; `tab` foca (`j` move a seleção na sidebar, não a conversa), `enter` abre o run; `a` na sidebar responde ao pendente do run selecionado; `mockMouse.drag(117, 5, 100, 5)` alarga (`prefs.sidebarWidth === 59`); **Review Focus 4** (`resizing from 160 to 80 columns collapses rail and sidebar without overflow`): `resize(80, 24)` → sem `Runs` da sidebar, tabs horizontais, última linha do frame é a linha de atalhos e nenhuma linha excede 80 chars.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): sidebar with runs, inbox and this-run blocks, spring width and mouse resize`.

---

### Task 12: Diálogos: runs, command palette, ajuda

**Files:**
- Create: `apps/tui/src/component/dialogs/runs.tsx`, `palette.tsx`, `help.tsx`
- Modify: `apps/tui/src/app.tsx` (ligar ctrl+o, ctrl+k, ?)
- Test: `apps/tui/test/dialogs.test.tsx`

**Interfaces:**
- Produces:

```ts
export function RunsDialog(): JSX.Element;    // Dialog large: <input> de filtro (fuzzysort sobre `${id} ${workflow} ${status}`), lista `<symbol> <id8> <workflow> <word> <age> <money>` (máx. 20 visíveis, ↑/↓, enter abre+activate, esc fecha)
export interface Command { id: string; label: string; keys: string; run(): void; when?: () => boolean }
export function commands(ctx: { route; data; dialog; sidebar }): Command[];   // new run, open runs, toggle sidebar, next/prev tab, close tab, cancel run, resume run, diff, help, quit
export function PaletteDialog(): JSX.Element; // Dialog medium: filtro fuzzysort sobre label; linha `<label>` + keys à direita em muted; enter corre
export function HelpDialog(): JSX.Element;    // Dialog medium centered: secções Global / Session / Sidebar / Dialogs com as teclas da spec §5
```

- [ ] **Step 1: Testes a falhar**: `ctrl+o` → `Runs` dialog com os dois runs; `typeText('bbbb')` deixa só `bbbb2222`; enter → `active === 'bbbb2222-x'` e rota session; `ctrl+k` → palette com `New run`; `typeText('side')` + enter → sidebar alterna; `?` na sessão (foco na conversa) → `Keys`, contém `ctrl+o`; `?` com o prompt da home focado escreve `?` no input (não abre).
- [ ] **Step 2–4:** ver falhar, implementar, ver passar.
- [ ] **Step 5: Commit** `feat(tui): runs picker, command palette and help dialogs`.

---

### Task 13: Diff: endpoint no daemon, cliente e diálogo

**Files:**
- Modify: `packages/daemon/src/server.ts`, `packages/daemon/src/run-manager.ts`, `packages/daemon/src/client.ts`, `packages/daemon/src/index.ts` (tipo `DiffResult`)
- Create: `apps/tui/src/component/dialogs/diff.tsx`
- Modify: `apps/tui/src/routes/session/index.tsx` (`d`), `apps/tui/src/testing/fake-client.ts`, `apps/tui/src/context/client.tsx` (`diff` obrigatório)
- Test: `packages/daemon/test/diff.test.ts`, `apps/tui/test/diff.test.tsx`

**Interfaces:**
- Produces:

```ts
// daemon
export interface DiffFile { path: string; status: 'added'|'modified'|'deleted'|'renamed'; additions: number; deletions: number }
export interface DiffResult { base: string; files: DiffFile[]; patch: string; truncated: boolean }
// RunManager.diff(runId): base = 'HEAD' (o worktree/branch do run parte do HEAD do projeto e o diff é contra o índice+working tree: `git diff HEAD --numstat` + `git diff HEAD`, tal como diffRunWorkspace de @shibaox/workspace; inplace: o mesmo no `workspace`); pasta inexistente → HttpError(404, 'no_workspace', 'The run workspace is gone'); patch > 2_000_000 chars → aparado + truncated true.
// GET /runs/:id/diff → 200 DiffResult; 404 not_found (run) / no_workspace.
// DaemonClient.diff(id: string): Promise<DiffResult>
// tui
export function DiffDialog(props: { runId: string }): JSX.Element; // Dialog xlarge: cabeçalho `<n> files · +<a> −<d>` + lista de ficheiros à esquerda (24 col, ↑/↓ ou [ ]) e <diff diff={patchOf(file)} view="unified" filetype={ext} showLineNumbers/> à direita; 404 no_workspace → linha `Workspace is gone`; patch truncated → `… truncated`; sem ficheiros → `No changes`.
// patchOf(file): fatia do patch entre `diff --git a/<path>` e o próximo `diff --git`.
```

- [ ] **Step 1: Testes a falhar**: daemon (repo git em tmp: ficheiro alterado + ficheiro novo) → `files` com 2 entradas (`modified` 1/0, `added` n/0), `patch` contém `diff --git a/a.ts`; pasta apagada → 404 `no_workspace`; run desconhecido → 404; patch enorme (ficheiro de 3 MB) → `truncated true`; `DaemonClient.diff` contra o servidor de teste devolve o mesmo. TUI: `d` na sessão sem pendente → dialog com `2 files`, `a.ts`; `]` muda de ficheiro; `esc` fecha; `diffs` sem entrada e `failing`-like 404 → `Workspace is gone`.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar (`pnpm --filter @shibaox/daemon test`, `bun test`).
- [ ] **Step 5: Commit** `feat(daemon,tui): run diff endpoint and diff viewer`.

---

### Task 14: Entrada, motion off, README e validação em pty

**Files:**
- Modify: `apps/tui/src/main.tsx`, `apps/tui/src/app.tsx` (`animations` = `!(env.SHIBAOX_NO_MOTION==='1') && prefs.animations !== false`; log de frames malformados em `~/.shibaox/tui.log`), `README.md` (secção Dashboard: home, sessão, teclas, diff, `SHIBAOX_NO_MOTION`, Bun 1.3+), memória do projeto
- Test: `apps/tui/test/motion-off.test.tsx`; validação manual em pty

- [ ] **Step 1: Teste a falhar**: `SHIBAOX_NO_MOTION=1` → sessão com run running mostra `▪` em vez de spinner e o header `Working` sem shimmer (frame igual em dois `captureCharFrame` com 300 ms de intervalo); com motion (env vazio) dois frames a 300 ms diferem no spinner.
- [ ] **Step 2–4:** ver falhar, implementar, ver passar; `pnpm build && pnpm test && pnpm lint`.
- [ ] **Step 5: Validação em pty** (script como na 2A-2, 140×40 e 80×24, contra o daemon real em `~/.shibaox` com `~/shibaox-demo`): home com logo e prompt; `/workflow hello-feature` autocompleta; enter abre a sessão com `analyse` a girar; run terminado mostra summary; `d` abre o diff; `ctrl+o` lista; `ctrl+q` sai com o ecrã restaurado; `shibaox follow <id>` imprime o estado final. Capturas guardadas no workspace do plano.
- [ ] **Step 6: Commit** `feat(tui): entry, motion switch, README and pty validation`.

---

## Self-review

- **Cobertura da spec**: §1 pacote/arranque → T1, T14; §2 tema → T2; §3 motion → T3 (+ pulse T10, spring T11, presença atrasada T6/T10, marquee T7/T10); §4.1 home → T7; §4.2 sessão → T8, T9; §4.3 tabs → T10; §4.4 sidebar → T11; §4.5 diálogos/overlays → T6, T9 (confirm), T12, T13 (diff), T10 (reconnecting, too small); §4.6 toasts → T6 (+ uso em T5/T7/T9); §5 teclas → T5 (scopes), T9, T10, T11, T12; §6 dados → T4, T5, T13 (daemon); §7 erros → T5 (inacessível), T9 (409), T14 (log), T8 (limite 5000), T10 (too small); §8 testes → todas; §10 verificação → T14.
- **Tipos**: `Card`/`Block` (T4) usados em T5 (`timeline`), T8, T11; `DataState`/`Data` (T5) em T7–T13; `useKeys(scope)` (T5) em T6, T9, T10, T11, T12; `DiffResult` (T13) na fake desde T1 como opcional e obrigatório em T13; `Feedback` (T2) em `statusOf` (T4) e toasts (T6).
- **Placeholders**: nenhum; os ficheiros copiados do opencode têm a assinatura fixada e a origem no cabeçalho.
- **Review Focus**: 1 → T4(f) + T8; 2 → T9; 3 → T5; 4 → T11; 5 → T4(g) + T8.
