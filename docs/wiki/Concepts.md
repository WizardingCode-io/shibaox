# Concepts

## Org

An **org** is a directory of YAML: `org.yaml` (name, teams, budgets, default adapter, vault), `models.yaml` (tiers and per-role models), `teams/`, `roles/`, `workflows/`, `gates/`, and optionally `catalog/` (skills, plugins, MCPs) and `prompts/`. `shibaox init .` scaffolds one; the daemon keeps a default org in `~/.shibaox/org` for projects without one.

## Teams and roles

A **team** names a lead, its roles, the gates every one of its workflows must pass, and its workflows. A **role** says what an agent is (`description`, `system_prompt`), which tier it runs on (`model_tier: strong|cheap`), which tools it may use (`tools: [read, write, git, node, pnpm]`), its permissions (`network` hosts, `approval_required: [push, deploy]`), its limits (`max_steps`, `max_turns`, `budget_usd`) and its capabilities (`orchestrate`, `memory`).

## Workflows and nodes

A **workflow** is a graph of nodes:

| Node | What it does |
| --- | --- |
| `task` | an agent of a role works on the instruction (`role`, `instruction`, `next`) |
| `code` | runs a shell command in the workspace (`command`, `timeout_ms`, `skip_if_missing` to complete with a note when the program is not installed, `ok_exit_codes` for tools that exit non-zero when they have something to report, default `[0]`) |
| `gate` | runs gates; `on_pass` / `on_fail` (with `max_retries`) route the run |
| `decide` | a decision model picks one of `options` (`by`, `question`, `next: { option: node }`) |
| `human` | waits for you in the inbox (`action`, `prompt`) |
| `git` | `commit`, `pr` or `merge` the run's branch (`message`, `base`, `tests`) |
| `parallel` | fans out to `branches` and joins at `join` |

A workflow marked `conversation: true` is a chat: one turn per run, in place on the project, the thread carried between turns. The template ships `chat` (the orchestrator), `hello-feature` and `land-feature`.

## Gates and checks

A **gate** lists checks: `tests` (the project's own test runner), `lint` (its linter), `review` (a model reviews the change against a rubric), `judge` (a model answers a rubric), `jev` (a typed question to Jev), `code` (a command, `skip_if_missing` allowed), `typecheck` (the project's type checker, found at run time), `human`. A team's gates are injected into every workflow of the team that does not already cover them. See [Gates](Gates).

## Runs and events

A **run** executes one workflow on one project. Everything that happens is an event in an append-only log (SQLite in `~/.shibaox/events.db`): created, node started, tool calls, gate reports, decisions, human answers, cost. The run's state is derived by replaying the log, so a run can be inspected at any point, resumed after a crash, paused on budget and continued with a higher one. `shibaox replay <runId>` shows the log and the state.

## Adapters

A task runs on a **runtime adapter**:

- **direct** — Shibaox's own agent loop on the AI SDK, any provider in the catalog, tools scoped to the workspace. Streams text, runs tool calls written as text by models without native tool calling.
- **claude-code** — the Claude Agent SDK, for `anthropic-subscription/...` models (your Claude login) or Anthropic API models. Role tools map to Claude Code permissions.
- **mock** — completes nodes at once, no model. For trying workflows and for tests.

The adapter follows from the model chosen for the run, else from `adapter:` in `org.yaml`, else the org's tiers.

## Tiers

`models.yaml` names a model for each tier: `strong` (the best model, for tasks that need it), `cheap` (the orchestrator, summaries, commit messages), `decision` (decide nodes: any `provider/model`, or `jev-latest` with a TypeSafe key). `gates.judge` sets the model of `judge` and `review` checks (default: decision, then strong). Change them with `/tiers` or `shibaox tiers set`.

## Workspace and worktrees

A run works **in place** (on the project checkout) or in a **worktree** (`<project>/.shibaox/worktrees/<runId>` on branch `shibaox/<runId>`, the default in a git repository). Conversations run in place; team runs in a worktree. See [Worktrees](Worktrees).

## The daemon

Everything runs inside a per-user **daemon** (`~/.shibaox/`): runs, the inbox of approvals, schedules, channels, the key vault, model discovery. The CLI and the dashboard talk to it over a Unix socket. See [Daemon and service](Daemon-and-service).

A running task can be **steered**: a note from you (`shibaox steer`, `s` in the dashboard) or from the orchestrator (`steer_run`) stops it and starts it again with the note, its runtime session kept; the run log records `NodeSteered` (and `NodeAttemptDiscarded` when the task finished anyway before it noticed, its cost still counted) and the audit lists the notes. Only a task with a live model call can be steered: gates, git steps, decisions and human nodes cannot, and a task that just finished is past steering. Runs of one conversation share a **thread** (the first run's id): the orchestrator sees and steers every run dispatched in it, whichever turn started it.
