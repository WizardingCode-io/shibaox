# Fase 3B — Rotinas 24 h Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the daemon runs as a launchd service, scheduled and Telegram-originated runs deliver a report where they were asked for, and the orchestrator answers Telegram text.

**Architecture:** `RunCreated.origin` records who asked; when an origin run ends the RunManager hands a `RunReport` to the daemon, which enqueues it in the existing outbox for channels implementing `report()`. The Telegram channel gains inbound text (`onMessage`) and `/status`; the daemon keeps a per-chat thread in memory and submits `chat` runs. A `service.ts` module renders the plist and drives `launchctl` through an injectable exec.

**Tech Stack:** TypeScript strict, zod 4, vitest, croner, Telegram Bot API over fetch, launchd.

**Spec:** `docs/superpowers/specs/2026-09-27-shibaox-3b-rotinas-design.md`

## Global Constraints

- `pnpm build && pnpm test && pnpm lint` green (0 errors; the 9 accepted warnings may stay).
- Schema additions optional (old logs replay). Outbox rows without `type` are inbox items.
- Channels never receive file contents, diffs or tool output: node summaries ≤ 200 chars, prompts only.
- No secrets in the plist: the login shell provides the environment.

## Review Focus

1. A report for a run whose workflow snapshot is missing (old run) must still be built — Task 2 test.
2. A Telegram `message` from another chat id is ignored and logged, never answered — Task 3 test.
3. A reply longer than 4000 chars is sent in several messages, HTML-escaped — Task 3 test.
4. `daemon install` when a detached daemon is already running: it is stopped first (or the two would fight over the socket) — Task 4 test on the exec/stop calls.
5. Outbox rows from before 3B (plain `InboxItem` payloads) still deliver as notifications — Task 2 test.

---

### Task 1: `origin` end to end

**Files:** `packages/schemas/src/events.ts`, `packages/core/src/run/{state,reducer,engine}.ts`, `packages/daemon/src/{run-manager,scheduler}.ts`
**Tests:** `packages/core/test/reducer-3a.test.ts` (origin in state), `packages/daemon/test/scheduler.test.ts` (fire passes `origin: schedule:<id>`), `packages/daemon/test/run-manager.test.ts` (submit stores origin; `list()` exposes it; a child dispatched by `start_workflow` inherits the parent's origin — unit test on `taskTools` is indirect: assert via `orchestrationTools.startWorkflow` in run-manager: skip; cover by the chat/claude-code run test reading `RunCreated.origin` of a submit with origin).

- [ ] Tests RED → implement (`origin?: string` everywhere; scheduler `fire` adds origin; `taskTools.startWorkflow` passes `origin: r.origin`; `buildEngine` gets `origin` from submit/rebuild) → GREEN → commit `feat: runs record their origin (schedule, telegram); children inherit it`.

### Task 2: Run reports through the outbox

**Files:** create `packages/daemon/src/runs/report.ts` (`RunReport`, `buildRunReport(state, events, workflow?, o?: { notePath?: string })`); modify `channels/types.ts` (`report?(r: RunReport): Promise<void>`), `channels/outbox.ts` (`enqueueReport(r)`: rows for channels with `report`; `tick` parses `{ type: 'report', report }` vs `InboxItem`), `channels/telegram.ts` (`telegramReportText`, `report()` with 4000-char chunks), `channels/macos.ts` (`report()`), `run-manager.ts` (`RunManagerOptions.onFinished?: (state: RunState, events: StoredEvent[], workflow?: Workflow, notePath?: string) => void`, called in `execute` finally when terminal and `state.origin`; `finishRun` returns the note path), `daemon.ts` (wires `onFinished` → `buildRunReport` → outbox or direct channel `report`).
**Tests:** `packages/daemon/test/report.test.ts` (new): completed team run → status/nodes/summaries/branch/duration; chat run → `reply` = text of the last completed task node's output (`output.text` or `summary`); waiting run → `needs`; missing snapshot → still built; `telegramReportText` chunks and escapes. `outbox.test.ts`: report rows only for channels with `report`; legacy InboxItem payload still notified. `run-manager.test.ts`: origin run → `onFinished` called once with the state; no origin → not called.

- [ ] RED → implement → GREEN → commit `feat(daemon): runs with an origin deliver a report through the channels (Telegram, macOS) and the vault note path`.

### Task 3: Telegram inbound text and `/status`

**Files:** `config.ts` (`telegram.org?`, `project?`, `workflow` default `'chat'`, `adapter?`), `channels/telegram.ts` (`allowed_updates` + `message`; `onMessage(cb)`; `status?: () => Promise<string>` option; `/status`, `/help`; `sendChatAction typing`; `sendText(text)` helper with chunking), `daemon.ts` (`TelegramThreads`: `Map<chatId, ChatMessage[]>` capped 20 turns; `onMessage` → submit chat run with origin; on report with `reply` push the assistant turn; missing org/project → the explanatory message), `server.ts` health unchanged.
**Tests:** `telegram.test.ts`: text message → `onMessage('olá')` + `sendChatAction`; other chat → ignored + no send; `/status` → `sendMessage` with the status text; `report()` of a chat run sends the reply; long reply chunked. `daemon`-level test in `server.test.ts` or new `telegram-daemon.test.ts`: fake Telegram + mock adapter chat run: a text message submits a run with `origin: telegram:<id>` and `messages` from the thread; when it ends the fake receives the reply.

- [ ] RED → implement → GREEN → commit `feat(daemon): talk to the orchestrator from Telegram; /status`.

### Task 4: launchd service

**Files:** create `packages/daemon/src/service.ts` (`LAUNCHD_LABEL = 'io.shibaox.daemon'`, `plistPath(env)`, `renderPlist({ node, cli, home })`, `installService({ paths, node, cli, exec, env })`, `uninstallService(...)`, `serviceStatus(...)` → `'installed' | 'not-installed'` via `launchctl print gui/<uid>/<label>`); `apps/cli/src/commands/daemon.ts` (`daemonInstall`, `daemonUninstall`; `daemonStatus` + `doctor` show the service line; `daemonStop` notes KeepAlive when installed), `apps/cli/src/index.ts` (commands).
**Tests:** `packages/daemon/test/service.test.ts`: plist XML has label, zsh -lc exec line, KeepAlive/RunAtLoad, log paths; `installService` writes the file and calls `launchctl bootstrap gui/<uid> <plist>` (fallback `load -w` when bootstrap fails); `uninstallService` calls `bootout` and removes the file; `serviceStatus` from exec exit code. CLI test `apps/cli/test/daemon-service.test.ts` (fake exec through an env hook? keep to the daemon package tests + one CLI smoke that `daemon install --help` exists).

- [ ] RED → implement → GREEN → commit `feat(cli): shibaox daemon install/uninstall (launchd), service in status and doctor`.

### Task 5: Docs and live check

- [ ] README Daemon section: service, reports, Telegram text/`/status`, `daemon.yaml` keys.
- [ ] Live: `shibaox daemon install` (stops the detached daemon, launchd starts it), `daemon status` shows `service: launchd (installed)`; a schedule of `chat` with `schedule run` → daemon log shows `report:` and the macOS notification fires.
- [ ] Commit `docs: daemon service, reports and Telegram conversations`.
