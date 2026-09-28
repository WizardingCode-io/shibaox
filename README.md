# shibaox

An agent OS over coding runtimes: an organisation is described as YAML (teams, roles,
gates, workflows), and a run engine executes workflows as an event-sourced graph of
`task`, `code`, `gate`, `decide`, `human` and `parallel` nodes.

## What phase 1A is (and what comes in 1B)

Phase 1A is the engine on its own: zod schemas and the org loader (`packages/schemas`),
the event store, reducer, order-based scheduler, gate engine, team-gate injection and
`RunEngine` (`packages/core`), a SQLite event store (`packages/persistence-sqlite`) and
the `shibaox` CLI (`apps/cli`). Every run is an append-only event log, so any run can be
replayed, inspected and resumed after a human pause, a budget pause or a crash. Task
nodes run on a **mock** runtime adapter and `decide` nodes use a scripted decider, so the
whole flow runs offline with no API keys. Phase 1B plugs in the real pieces: the Claude
Code runtime adapter (worktree per run), the Jev client for `decide` nodes and judge
checks in gates, the model/cost router from `models.yaml`, and memory (vault notes and
graphify).

## Prerequisites

- Node.js >= 22
- pnpm >= 10 (`corepack enable` picks the version pinned in `package.json`)
- git
- A C/C++ toolchain, only if `better-sqlite3` has no prebuilt binary for your platform.
  On macOS: `xcode-select --install`.

If `pnpm install` fails while building `better-sqlite3`:

```sh
npm i -g node-gyp
pnpm rebuild better-sqlite3
```

## Build and test

```sh
pnpm install && pnpm build && pnpm test
```

`pnpm typecheck` and `pnpm lint` are also available.

## Running the CLI

After `pnpm build`, run the CLI either directly or through pnpm:

```sh
node apps/cli/dist/index.js --help
pnpm --filter @shibaox/cli exec shibaox --help
```

The examples below use `shibaox` as shorthand for either form. With pnpm, relative
paths resolve from `apps/cli`, so prefer absolute paths there.

## Walkthrough with the sample repo

```sh
# 1. Scaffold an org repo (org/) and a vault (vault/) in a working directory.
mkdir -p /tmp/shibaox-demo && cd /tmp/shibaox-demo
shibaox init .

# 2. Check local prerequisites (node and git are required; the rest is for phase 1B).
shibaox doctor

# 3. Run the hello-feature workflow against a copy of the sample repo. The first command
#    that needs the daemon starts it in the background (see Daemon below).
cp -R <path-to-shibaox>/examples/sample-repo ./project
shibaox run hello-feature --org ./org --project ./project --input "add /health"
```

`hello-feature` runs `analyse → implement → qa (gate: the project's own tests) → judge (decide) → ship
(human)`. `run` submits the run to the daemon and follows it; in an interactive terminal
the `ship` node asks `Approve the push? (y/n)` right there. Without a TTY the run keeps
waiting in the inbox (`shibaox inbox`, `shibaox approve human:<runId>:ship`). Ctrl-C stops
following, never the run. Other useful flags: `--detach` (submit and return), `--budget
<usd>` (defaults to `budgets.per_run_usd` in `org/org.yaml`), `--workspace` and `--graph`
(see [Worktrees](#worktrees) and [Memory](#memory-vault--graphify)), and `--json` on every
command. The copied project is not a git repository, so this run works in place; in a git
repository it runs in a worktree.

```sh
# 4. List runs, follow one, replay its event log and derived state.
shibaox runs
shibaox follow <runId>
shibaox replay <runId>

# 5. Answer what is waiting for you, or continue a run: lift a budget pause, or re-run
#    nodes interrupted by a crash. Exit code 0 when the run completes, 2 otherwise.
shibaox inbox
shibaox approve human:<runId>:ship --note "ship it"
shibaox resume <runId> --budget 10   # required after a budget pause
```

## Daemon

Runs execute inside a per-user daemon (`~/.shibaox/`, or `$SHIBAOX_HOME`): closing the
terminal never kills a run, and approvals wait in a persistent inbox. Any command that
needs it starts it in the background and says so; `SHIBAOX_NO_AUTOSTART=1` disables that.

```sh
shibaox daemon start --detach   # or in the foreground: shibaox daemon start
shibaox daemon status
shibaox daemon stop             # waits for active runs; --force cancels them
shibaox daemon install          # macOS: a launchd agent starts it at login and restarts it
shibaox daemon uninstall
```

- **Service.** `daemon install` writes `~/Library/LaunchAgents/io.shibaox.daemon.plist` and
  loads it: the daemon starts now and at every login, and launchd restarts it if it exits.
  The agent runs the CLI through `/bin/zsh -lc`, so it gets the environment of a **login**
  shell: exports in `~/.zprofile` or `~/.zshenv` reach it, exports only in `~/.zshrc` do not
  (`daemon install` checks the keys your shell has and says which ones the service would
  miss); nothing is copied into the plist. The plist runs `~/.shibaox/daemon.sh`, a launcher
  that records the `node` and CLI paths of the install and, when either moved (a Node
  upgrade under nvm or brew), falls back to the login shell's `node` when it has the same
  ABI (native modules were built for it) and to `shibaox` on the PATH; otherwise it says why
  in `daemon.log` and waits, and `daemon status` and `doctor` tell you a `daemon install` is
  due (also for a service installed before the launcher: reinstall once). `daemon stop` stays until the daemon is gone,
  saying how many runs it waits for (`--force` cancels them), then when launchd will start it
  again. Relative `org`/`project` in `daemon.yaml` resolve next to that file. Text messages
  that piled up on Telegram while the daemon was down: only the last one is answered, and the
  chat is told how many were skipped.

- **Files.** `daemon.sock` (0600, HTTP JSON + SSE, no authentication: only your user reaches
  it), `daemon.pid`, `daemon.log`, `daemon.yaml`, `events.db` (one SQLite database for every
  org and project you run).
- **Inbox.** `shibaox inbox` lists human nodes (`human:<runId>:<node>`) and tool approvals
  (`approval:<id>`, a push or deploy asked by a Claude Code or direct task). `approve` and
  `deny` answer them, with an optional `--note`. The first answer wins; a second one is
  refused. An approval applies to that exact command on that node: the task never asks
  twice for the same command.
- **Sessions.** While a Claude Code task waits for an approval its session stays open. After
  `approval_timeout_minutes` (default 120), or when the daemon restarts, the task is
  suspended and resumed with `session_id` once you answer, with a note saying what was
  decided.
- **Concurrency.** `max_concurrent_runs` in `daemon.yaml` (default 4) and in `org.yaml`
  (default 2); runs above the limits wait as `queued`.
- **Channels.** macOS notifications (`osascript`, or `terminal-notifier` when installed) and
  Telegram with Approve/Deny buttons. Channels get the command, run, node and role, never
  file contents, diffs or tool output. Failed deliveries retry with backoff.
- **Schedules.** `shibaox schedule add "0 9 * * 1-5" hello-feature --org ./org --project
  ./project --input "daily check"`, `schedule list|rm|run`. A schedule whose previous run is
  still active is skipped (logged).
- **Reports.** A run asked for by a schedule or from Telegram carries an `origin`
  (`schedule:<id>`, `telegram:<chatId>`; runs it dispatches inherit it). When it ends, a
  report goes through the outbox to every channel that shows reports: Telegram gets `✓
  hello-feature done · 5 nodes · $0.12 · 8m 42s · branch …` plus one line per node (≤ 200
  chars), what still needs you, the error, and the vault note path; macOS gets a
  notification. A conversation run (`conversation: true`) reports its reply only.
- **Talking from Telegram.** With `org` and `project` set under `channels.telegram`, any text
  you send the bot from your **private** chat (groups are ignored: the orchestrator writes to
  the project) is a turn for the orchestrator, one at a time (texts sent while it answers
  wait their turn): a `chat` run (in place, on that project)
  with the conversation so far, whose reply comes back to the chat. `/status` answers with
  the daemon, its runs and what needs you; `/help` lists this. The thread lives in memory
  (a restart forgets it; the orchestrator's `remember` notes do not).

`daemon.yaml` (every key optional):

```yaml
max_concurrent_runs: 4
approval_timeout_minutes: 120
channels:
  macos: { enabled: true }
  telegram:
    bot_token_env: SHIBAOX_TELEGRAM_TOKEN
    chat_id: 123456789
    org: /path/to/org          # with org + project, text messages talk to the orchestrator
    project: /path/to/project
    workflow: chat             # default
    # adapter: claude-code
```

- **Keys.** API keys and tokens live in shibaox's own vault, `~/.shibaox/secrets.json`
  (0600, inside the 0700 home), shared by the daemon, the CLI and the dashboard through the
  daemon's API (`GET /keys` masked, `PUT /keys/:name`, `DELETE /keys/:name`):

  ```sh
  shibaox keys list                              # every key shibaox knows, set or missing, where from
  shibaox keys set OPENROUTER_API_KEY sk-or-...   # or: echo sk-or-... | shibaox keys set OPENROUTER_API_KEY
  shibaox keys unset OPENROUTER_API_KEY
  ```

  In the dashboard `/keys` shows the vault and `/key NAME value` sets one. A key set this way
  is used by the next run at once (no restart), reaches the launchd service whatever your
  shell exports, and wins over the environment. The shell environment stays a fallback:
  keys exported there still work, and `doctor` says which of the two a key comes from. The
  Telegram channel follows the token in the vault: set `SHIBAOX_TELEGRAM_TOKEN` and it starts
  polling at once; remove it and it stops; change it and it restarts, no daemon restart needed.
  A run's `--model` / `/model` is checked against the provider's own listing when there is one
  (OpenRouter with a key, a local server that answers): a typo is refused at submit instead of
  failing minutes later.

- **Tiers.** Which model each tier of an org runs on (`strong`, `cheap`, `decision`), the
  `judge` model, the default `adapter` and the budget per run are set without editing YAML,
  through the daemon (`GET/PUT /orgs/config?org=…`, which rewrites `models.yaml`/`org.yaml`
  keeping the comments):

  ```sh
  shibaox tiers                                   # the org's tiers, judge, adapter and budget
  shibaox tiers set strong openrouter/openai/gpt-5
  shibaox tiers set decision openrouter/typesafe/jev-router
  shibaox tiers set judge none                    # back to the default (decision, then strong)
  shibaox tiers set budget 10
  ```

  In the dashboard `/tiers` lists the same rows; enter on one opens the model list (the
  same as `/model`, typing filters) and enter saves. The next run uses the new tiers.

`shibaox doctor` reports the daemon (and whether it is older than the CLI), Telegram
(`getMe` with the configured token) and the `claude` login.

## Dashboard

`shibaox` with no command (or `shibaox ui`) opens the dashboard over the daemon. It is an
[OpenTUI](https://opentui.com) + Solid app (`apps/tui`) and runs under [Bun](https://bun.sh)
1.3 or later (checked by the CLI, which spawns it for you); without Bun the CLI says so and
the text commands keep working. `pnpm test` also needs Bun for the dashboard's own tests. It
needs an interactive terminal of at least 60×15.

**Home** shows the logo and a prompt: type what you want and press `enter`. The org's `chat`
workflow (the default) talks to the orchestrator (see below); any other workflow starts a
team run. `/model` lists every model of the providers catalog (`GET /models`: configured
ones first, the others say which key they miss; with `OPENROUTER_API_KEY` in the vault the
whole OpenRouter catalogue is listed too, with its context windows; LM Studio and Ollama are
asked what they have running) and pins one for the run
(`provider/model`, e.g. `anthropic-subscription/claude-sonnet-5`): every task runs on it,
the adapter follows from it (a subscription model goes through Claude Code, an API or local
one through the direct loop), the choice is remembered, and `shibaox run --model <ref>` does
the same from the command line. In a run tab, `/model` sets the model of the next turns.
Models without native tool calling (many local ones, some routers) tend to write their calls
as text (`<tools>{"name": …}</tools>`, `<tool_call>…</tool_call>`, a fenced JSON block):
the direct adapter runs those as real tool calls, hands the results back and lets the model
continue, so the conversation shows `⊙ start_workflow …` rather than raw XML. The direct
adapter streams the model's text as it arrives (held back from the first sign of a call
written as text, so no half-written call ever shows). Under the prompt, one line says what the current project is (`Next.js · React ·
TypeScript · pnpm test · 412 files`, from `GET /projects/profile`). `/` commands set the context shown inside the prompt: `/workflow`, `/adapter`
and `/workspace` step into a list to pick from (`enter` takes the highlighted value),
`/project <dir>`, `/org <dir>` and `/budget <usd>` take a value, `/runs` and `/help` open
their dialogs. The org defaults to `./org`, the project to the current
directory; the last org, adapter and workflow are remembered in `~/.shibaox/ui.json`. The
footer shows the daemon, how many runs are working or queued, and how many things need you.

**A run** opens as a tab and reads like a conversation: one card per node (task, gate,
decision, human step) with the agent's text in Markdown, tool calls (`> Read src/a.ts · 7 ms
· done`, `enter` shows input and output), touched files, gate checks, the decision and its
confidence, and a summary at the end (status, cost, duration, files changed, branch). While
the run waits for you, the bottom of the screen asks: `a` approves, `d` denies, `n` adds a
note (a command approval asks `y` first). Runs that end or start waiting in another tab make
their tab pulse until you open it. When a run ends, the prompt comes back at the bottom of its
tab: the next request runs in the same tab and the conversation so far travels with it
(`messages` on `POST /runs`). A chat turn reads as a message: your request, then the
orchestrator's reply, without node chrome; a run the orchestrator dispatched shows up in the
same tab under `→ <workflow>` with its own cards, approvals and diff, and when it ends a quiet
`↳ workflow … finished` line hands the outcome back to the orchestrator, which replies. In a
run tab `/` offers the screen's commands (`/diff`, `/cancel`, `/resume`, `/sidebar`, `/home`,
`/runs`, `/help`, `/close`, `/quit`; the same ones as the `ctrl+k` palette), and under the
status while it works, and under the prompt once it is done, one line says where you are:
how full the model's context is (`12% ctx`, from the runtime's usage; `24.0k tokens` when the
window is unknown), the model (the planned one, muted, until the runtime names it), the git
branch (`⎇ main`), the project, the org, the workflow, the cost of the thread and the time. The sidebar (automatic from 120 columns, `ctrl+b`) shows
the run's request, its cost and progress, the nodes as a checklist, the files it touched and
what needs you; drag its edge with the mouse to resize it. The runs picker is `ctrl+o`.

Keys: `ctrl+n` home · `ctrl+o` open a run · `ctrl+k` command palette · `ctrl+]`/`ctrl+p`
next/previous tab · `ctrl+w` close tab · `ctrl+b` sidebar · `?` help · `ctrl+q` quit (the
daemon keeps running). In a run: `j/k` move the cursor, `↑/↓` or the mouse wheel scroll,
`enter` expand, `g`/`G` top/follow, `d` diff of
the run's checkout (`GET /runs/:id/diff`), `c` cancel, `r` resume, `tab` sidebar. Runs that
the daemon no longer streams (older than the last 50 finished) still show their nodes from
the run state. `SHIBAOX_NO_MOTION=1` (or `"animations": false` in `ui.json`) turns every
animation off.

In an interactive terminal with Bun installed, `shibaox run` (without `--detach`) and
`shibaox follow` show the same run view; without a TTY, without Bun, or with `--json`, they
print plain lines as before. When the run ends, the view closes and the run's final state is
printed; `q` leaves it running in the daemon.

## The orchestrator

The org template ships an `assistant` role and a `chat` workflow marked `conversation: true`: the orchestrator
you talk to in the dashboard. It answers in your language, **acts** (reads and writes files in
the project, runs the programs listed in its `tools`, fetches pages), **dispatches** larger
work to the org's workflows with a `start_workflow` tool (the run gets `parentRunId` and joins
the conversation), and **remembers** with `remember`/`recall` (see Memory). Every task of a
run starts with a preamble: the project's profile and the memory notes.

Role fields that drive this (`roles/<name>.yaml`):

```yaml
capabilities: [orchestrate, memory]   # orchestrate → start_workflow; memory → remember/recall
tools: [read, write, git, node, npm, pnpm, bun, python3]
permissions:
  network: ['*']                       # hosts the role may fetch (`*` = any; `github.com` covers subdomains)
  approval_required: [push, deploy]
max_steps: 40                          # direct adapter tool-loop steps (default 12)
max_turns: 80                          # Claude Code agent turns (default 60)
budget_usd: 1                          # optional cap per task, within the run budget
model_tier: cheap                      # the conversation runs on the cheap tier; teams use their own
```

With `permissions.network` set, the direct adapter exposes `web_fetch` (GET as text, HTML
reduced to text, 200 kB) and the Claude Code adapter allows `WebFetch`/`WebSearch`, both
checked against the allowlist per host (redirects included). `write` in `tools` is what lets
the direct adapter write files (`write_file`); programs run by allowlist as before. A
`conversation: true` workflow runs **in place** on your checkout; dispatched team runs use the
org default (a worktree in a git repository). The turn shibaox submits when a dispatched run
ends (`event: true` on `POST /runs`) never gets `start_workflow`, so nothing re-dispatches
without you. Memory notes reach only roles with the `memory` capability, quoted as data. Opened in your home directory itself, the dashboard works in
`~/.shibaox/workspace`.

**Gates `lint` and `review`.** Two checks any gate can use, shipped as template gates
`lint.yaml` and `review.yaml`: `{ type: lint }` runs the project's linter detected in the
workspace (`scripts.lint` through the project's package manager, else biome, eslint, ruff,
phpstan, golangci-lint or `go vet`, clippy, `make lint`; `command:` fixes it), failing the
gate with the linter's output as evidence and passing with a note when there is none;
`{ type: review }` asks the judge model (`models.gates.judge`, else `decision`, else `strong`)
to review the change criterion by criterion (`criteria:` list, else the built-in rubric:
scope, correctness, tests, hygiene, clarity), with evidence per criterion and suggestions for
the ones that fail (they feed the rework loop through `on_fail`); a criterion the model does
not answer counts as failed. A linter that is not installed where the daemon runs (`ruff` in a
venv, `vendor/bin/phpstan`, a pnpm project's worktree without `node_modules`) is a skipped pass
with a note, never a failure to fix. `land-feature` gates on `[tests]`; add `lint` once the
base branch is lint-clean (otherwise the agent is asked to fix the whole repository) and
`review` for a model review before the human approval.

**Git cycle.** A `git` node is a step the daemon runs itself (trusted org config, like
`code`), for **worktree runs** (`merge` and `pr` refuse an in-place run; an in-place `commit`
stages what is under the workspace only). `{ type: git, action: commit }` commits the
workspace with a message written by the `cheap` tier (else `strong`, else the run's model)
from the request and the diff, or deterministic text when no model can be called from the
daemon (Claude subscription tiers); `message:` fixes it; trailer `Shibaox-Run: <id>`.
`{ type: git, action: pr }` pushes the run branch and opens a pull request with `gh` (body
generated the same way; an open PR for the branch is reused). `{ type: git, action: merge }`
lands the run branch on the **base** (`base:` on the node, else the branch the project was on
when the run started, else the remote's default branch, else main) through the project's
**merge queue** (one merge at a time per project, in order): rebase on `origin/<base>` (the
local base when there is no remote); when the base moved under the branch, run `tests:` (else
the detected test command; `tests: ""` skips) on the rebased tree; push `branch:base` first
(the remote refuses anything but a fast-forward, so nothing local moves on failure), then
fast-forward the local checkout when it is on the base and clean (else the ref, else a note
`local <base> not updated: pull it`). A conflict or a failing test fails the node and leaves
the base untouched; a cancelled run never lands. Outside a git repository these nodes complete
with `committed: false` / `merged: false` and a reason. The template's `land-feature`
workflow is `hello-feature` plus a human approval, `commit` and `merge`; orgs created before
it get it by copying `land-feature.yaml` into `workflows/` and listing it in the team's
`workflows`.

**Long conversations.** Each turn carries the conversation so far as `messages`. When that
outgrows about 32k tokens (estimated), the daemon folds the oldest turns into one summary
written by the org's `cheap` tier (else `strong`; without a callable model the turns are cut
to lines), marked `summary: true` and kept first in the run's `messages`; the newest turns
stay whole. The adapters put the summary in the system prompt, the dashboard and Telegram
continue from the compacted thread, and `POST /runs` answers with the `messages` it used
(warning `conversation compacted`).

## Providers

Phase 1B-1 adds real models. Task nodes can run on the **direct** adapter (an AI SDK agent
loop with workspace-scoped tools), `decide` nodes use Jev with an LLM lead as fallback, and
gates can hold `jev` and `judge` checks.

### Catalog

The built-in catalog (`packages/providers/catalog.yaml`) lists the supported providers:
hosted APIs (Anthropic, OpenAI, Google, OpenRouter, Groq, Mistral, ...), gateways, local
servers and the subscription routes that go through a coding CLI (`via_runtime`). Entries
marked `unverified URL` have a base URL that was not confirmed yet.

```sh
shibaox providers list                # every provider and whether it is configured
shibaox providers list --configured   # only the usable ones
shibaox providers test groq           # one short real call with the first catalog model
shibaox providers test ollama --model qwen2.5-coder:7b
shibaox models --org ./org            # how each role of the org resolves to a model
```

### Gate checks

A gate lists checks. `type: tests` runs the project's own test runner, detected in the run's
workspace (`npm|pnpm|yarn|bun test` from `package.json`, `pytest`, `go test ./...`,
`cargo test`, `make test`, `php artisan test` / `vendor/bin/phpunit`, `bundle exec rspec`);
a project with none passes with a note, so the same org works in any repository.
`type: code` runs a fixed command (`command: "pnpm lint"`), `jev` asks Jev a typed question
about the diff, `judge` asks a strong model, `human` asks you.

### Environment variables

Each provider reads its key from the variable shown by `providers list` (for example
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`). Others:

| Variable | Used for |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev through TypeSafe's typed API (`tiers.decision: jev-latest`): `decide` nodes and `jev` gate checks. `tiers.decision` may instead name any model ref, e.g. `openrouter/typesafe/jev-router`: `decide` nodes and `judge` checks then run on that model through its provider, no TypeSafe key needed (models without structured output are asked for the JSON in plain text). Without either, `decide` nodes fall back to an LLM lead on the `strong` tier and `jev` checks fail. `shibaox init` ships the `spec` jev check in `org/gates/tests.yaml` commented out; uncomment it once the key is set. |
| `SHIBAOX_JEV_BASE_URL` | optional Jev endpoint override |
| `SHIBAOX_REAL_TESTS=1` | enables `apps/cli/test/real.test.ts` (real calls, needs keys) |

### models.yaml

Model refs are `<provider>/<model>`. Roles pick a tier (`strong`, `cheap`, `decision`), and
`roles:` can override the model per role. There are two ways to use Anthropic models:

```yaml
tiers:
  strong: anthropic/claude-sonnet-5          # API key: ANTHROPIC_API_KEY, direct adapter
  # strong: anthropic-subscription/claude-sonnet-5   # Claude subscription, via Claude Code
  cheap: ollama/llama3.2
  decision: jev-latest
gates:
  judge: anthropic/claude-haiku-4-5          # optional model for judge checks (default: strong)
```

`anthropic-subscription/...` runs through the Claude Code runtime (`--adapter claude-code`,
see [Claude Code runtime](#claude-code-runtime)); with the direct adapter it fails with a
clear message.

`shibaox run` uses the adapter from `--adapter mock|direct|claude-code`, else `adapter:` in
`org/org.yaml`, else **mock**; `resume` keeps the adapter the run started with unless
`--adapter` is given: provider keys in the environment never switch a run to real
models on their own. With `mock` no provider model is called (no LLM judge or lead; `decide`
nodes use Jev when `TYPESAFE_API_KEY` is set, else pick `ship`). Every run prints
`adapter=<id>`; with `direct` or `claude-code` it also prints `<role> → <target>` for each task role and
refuses to start (`cannot start: role "<role>" → <reason>`, before any event is stored) when
a role cannot resolve to a configured model.

### Local models

Ollama (`ollama serve`, port 11434) and LM Studio (port 1234) need no key:

```sh
ollama pull qwen2.5-coder:7b
# in org/models.yaml: strong: ollama/qwen2.5-coder:7b   (or lmstudio/<model>)
shibaox providers test ollama --model qwen2.5-coder:7b
shibaox run hello-feature --org ./org --project ./project --input "..." --adapter direct
```

### Costs and budgets

Spend is estimated from token usage and the catalog `pricing` (USD per million tokens,
indicative: verify against the vendor). Failed attempts count too. Models without pricing,
including local ones, report `$0`, so **a budget cannot stop them**: with `--budget` or
`budgets.per_run_usd` set, the direct adapter prints `warn: model "<ref>" has no pricing:
budget cannot be enforced for it` for each such model.

### Tool safety

The direct adapter gives a role the tools `list_files`, `read_file`, `write_file`,
`run_command` and `finish`, confined to the workspace. `write_file` refuses any path with a
`.git` segment (git config and hooks can run code).

`run_command` only runs the programs listed in the role's `tools:` (for example
`[git, node, pnpm]`). The command is split into argv and run **without a shell**: single and
double quotes only group words and are otherwise literal, nothing is expanded (`$VAR`, `~`,
globs, braces), backslashes and shell operators (`; & | $ < >` and backticks) are refused,
and arguments that are absolute, start with `~`, contain a `..` segment or name `.git` are
refused. The child gets a scrubbed environment (`PATH`, `HOME`, `LANG`, `TMPDIR`, `TERM`).

This is an **allowlist, not a sandbox**: an allowed program such as `node` or `pnpm` can
still run arbitrary code with your user's permissions (a `package.json` script, `node -e`,
`git` aliases). Cancelling a run does not kill a command that is already running; it runs
until it exits or hits its timeout. Run the direct adapter on projects and machines where
that is acceptable.

## Claude Code runtime

`--adapter claude-code` (or `adapter: claude-code` in `org.yaml`) runs task nodes through
Claude Code via the Claude Agent SDK. It keeps the org's routing: a role whose model is
`anthropic-subscription/<model>`, or `anthropic/<model>` for a role whose `runtime` is
`claude-code` (the default), runs in Claude Code with that model; any other role (for
example `ollama/...`) still runs on the direct adapter. Every role is resolved before the run
starts, and one that cannot run (a runtime other than Claude Code, an unconfigured
provider) stops it with `cannot start: ...`.

- **Subscription vs API key.** `anthropic-subscription/...` uses the login of the `claude`
  CLI (`claude` must be installed and signed in): for these roles shibaox removes
  `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the Claude Code process env, so an API
  key in your shell is not billed. With `anthropic/...` the Claude Code process gets
  `ANTHROPIC_API_KEY` from the environment. Each task prints
  `claude-code ready: model=<model> apiKeySource=<source> ...`, where `apiKeySource` is what
  Claude Code reports it authenticated with (for a subscription role it should never be
  `ANTHROPIC_API_KEY`). The
  Claude Code process only inherits `PATH`, `HOME`, locale/terminal variables,
  `SSH_AUTH_SOCK` and `ANTHROPIC_*`/`CLAUDE_CODE_*`; other secrets stay in shibaox.
- **Tools.** A role's `tools:` map to Claude Code permissions: `read` → Read/Glob/Grep,
  `write` → Edit/Write/MultiEdit/NotebookEdit, any other name → `Bash(<name> *)`. File
  tools get no blanket allow: each call is allowed only when its path (`file_path`,
  `notebook_path` or `path`, the working directory when absent) resolves, through
  symlinks, inside the task's working directory; `~`, `..` and absolute paths elsewhere
  are denied, Glob/Grep patterns may not be absolute or contain `..`, and writes under
  `.git` are denied. Everything else is denied, and always denied are `rm -rf`,
  `WebFetch` and `WebSearch`. Compound shell commands (`;`, `&&`, pipes, substitutions)
  are refused.
- **Push and deploy.** `git` and the deploy programs below never get a blanket allow:
  every call is classified, and a push or deploy is refused unless the role lists it in
  `permissions.approval_required` and a human approves it at that moment. Gated programs
  must be called by bare name (`./git`, `/usr/bin/git` are refused) and without shell
  expansion. Deploy verbs (anywhere among the positional arguments):

  | Program | Deploy verbs |
  | --- | --- |
  | `vercel` | `deploy`, `redeploy`, `promote`, `rollback`, `alias`, `remove`, `rm`; also bare `vercel`, `vercel <dir>` and `vercel --prod` (anything but its read-only subcommands) |
  | `fly`, `flyctl` | `launch`, `deploy` |
  | `netlify` | `deploy` |
  | `heroku` | `deploy`, `container:push`, `container:release`, `releases:rollback` |
  | `railway` | `up`, `deploy` |
  | `wrangler` | `deploy`, `publish` |
  | `kubectl` | `apply`, `create`, `replace`, `patch`, `scale`, `set`, `edit`, `delete`, `rollout` |
  | `terraform` | `apply`, `destroy`, `import`, `state` |
  | `helm` | `install`, `upgrade`, `uninstall`, `rollback` |
  | `npm`, `pnpm`, `yarn` | `publish`, `unpublish`, `dist-tag`, `dist-tags`, `deprecate` |
  | `docker` | `push`, and any invocation with `--push` (`docker buildx build --push`) |

  `gh` is not gated: a role that lists it can create releases or merge PRs without
  approval. git pushes are `git push`, `git send-pack`, `git subtree push` and
  `git lfs push`. The git classifier fails closed: unknown global options, `-c`,
  `--config-env`, `git config` writes (only `--get*`/`--list`/`get`/`list` are allowed),
  subcommand options that run programs (`--exec`, `--upload-pack`, `--receive-pack`, `grep -O`/`--open-files-in-pager`,
  `--template`, `--config`, `rebase -x`, `submodule foreach`, `bisect run`, ...),
  subcommands it does not know (including aliases) and `GIT_*` environment prefixes
  (other than `GIT_AUTHOR_*`/`GIT_COMMITTER_*`) are refused.
- **An allowlist, not a sandbox.** The classifier only sees the command line. An allowed
  interpreter or script runner is a full bypass: `node -e`, `npm run <script>`, a
  `package.json` script, `make`, or any script the task writes can run `git push` or a
  deploy without approval. git config, hook and alias tricks on the command line are
  refused, but Claude Code's Bash tool snapshots your shell rc files, so anything they
  export (including secrets) can reach the task's shell. Only list programs you would let
  the model run unattended, and run Claude Code tasks on machines where that is
  acceptable.
- **Subscription-only orgs.** `decide` nodes and `judge` checks call a model directly, and
  `anthropic-subscription/...` is only reachable through Claude Code. In an org whose
  models are all subscription models, `decide` nodes fall back to always choosing `ship`
  (the default path in the `shibaox init` template; a `decide` node without a `ship`
  option fails; Jev decides instead when `TYPESAFE_API_KEY` is set) and `judge` checks
  cannot run (they fail), until phase 2.
- **`approval_required` approvals.** A push/deploy inside a Claude Code task is answered from
  the inbox (`shibaox approve`, or Telegram once the daemon runs): the session waits on the
  request, and an approval applies to that exact command on that node. If nobody answers
  within the approval timeout, or the daemon restarts, the task is suspended with its
  `session_id` and resumed after the answer (`SessionStarted`/`NodeSuspended` events),
  with a short note telling the session what was decided.
- Settings files (`~/.claude`, project `.claude/`) are not loaded; the role prompt from
  `system_prompt` is appended to Claude Code's own system prompt.
- **Budget.** Spend reported by Claude Code counts against the run budget (`--budget` or
  `budgets.per_run_usd`), and the remaining budget caps each task (`maxBudgetUsd`). For
  `anthropic-subscription/...` roles this spend is **notional**: Claude Code reports a USD
  equivalent even though the subscription charges nothing per call, and it still counts
  against `per_run_usd`. When a task hits the cap the run pauses (`paused_budget`, the
  task's cost recorded) instead of failing; `shibaox resume <runId> --budget <higher>`
  re-runs that task.

## Worktrees

`run --workspace worktree|inplace` picks where tasks work. The default is `worktree` when
the project is a git repository, else `inplace`. A worktree run gets its own checkout at
`<project>/.shibaox/worktrees/<runId>` on a new branch `shibaox/<runId>` created from the
project's `HEAD` (uncommitted changes in the project are not in it; `.shibaox/` and
`graphify-out/` are added to `.git/info/exclude`). The main checkout is never touched. If the project is a
subdirectory of a larger repository, tasks run in the same subdirectory of the worktree.
A worktree needs a commit, and a subdirectory project must be tracked at `HEAD`: when
the worktree default cannot be used the run prints `warn: <reason>; running in place`
and works in place; an explicit `--workspace worktree` is refused instead
(`cannot use a worktree: <reason>; commit first or use --workspace inplace`).

Worktrees are kept after the run (the run prints `worktree: <path> (branch
shibaox/<runId>)`): review, commit and merge the branch yourself, then clean up:

```sh
shibaox worktree list --project ./project
shibaox worktree rm <runId> --project ./project [--delete-branch]
```

## Memory (vault + graphify)

**Vault.** `vault:` in `org.yaml` (relative to the org directory; `shibaox init` writes
`vault: ../vault`) points at an Obsidian vault. When a `run` or `resume` ends (`completed`,
`failed` or `cancelled`), shibaox writes `10-projects/<project>/runs/<date>-<runId8>.md`
(status, adapter, spend, nodes, last gate report, timeline) and one
`90-system/decisions/<date>-<runId8>-<node>.md` per `decide` node, and prints `note:
<path>`. Notes are never overwritten. Without `vault:` the run prints one warning.

**Profile and memory.** `10-projects/<project>/profile.md` is rewritten whenever the project
is profiled (the dashboard home, every run). Roles with the `memory` capability get
`remember({ scope, text })` and `recall({ query })`: `scope: user` appends to
`00-org/memory.md`, `scope: project` to `10-projects/<project>/memory.md` (dated bullet
lines); `recall` returns the lines containing every word of the query. The last 40 lines of
each note (4 kB at most) plus the profile line open every task's prompt.

**graphify.** A code knowledge graph of the project, built with
[graphify](https://pypi.org/project/graphifyy/) (installed with `uv tool install graphifyy`;
`graph build` tries this itself when `uv` is present):

```sh
shibaox graph build --project ./project      # writes ./project/graphify-out/graph.json
shibaox graph update --project ./project     # after code changes
shibaox graph query "where is add defined?" --project ./project
```

`run --graph auto` (the default) uses `graphify-out/graph.json` when it exists and never
builds it: direct roles get a `graph_query` tool, and Claude Code roles get the graphify
MCP server (`mcp__graphify__*`), which needs graphify's Python (a warning is printed and
the MCP is skipped when it cannot be found). `--graph off` disables both.

## Autorouting

Once per run, shibaox matches the org's catalog (`org/catalog/*.yaml` entries of type
`skill`, `plugin`, `mcp` or `tool`) against the first task role of the workflow and prints
`autoroute: attach=[...] ambiguous=[...]`. Without `TYPESAFE_API_KEY` the match is by tags
(entries sharing a tag with the role's name, capabilities, tools or team roles are
attached; the others are ambiguous). With the key (and a non-mock adapter) Jev scores each
candidate and attaches those at 0.8 or more. In this phase the result gates the graphify
MCP: when the catalog lists `graphify-mcp`, the MCP is attached only if autorouting
attaches it; without such an entry it is attached whenever the graph exists.

## Where state lives

Events are stored in `~/.shibaox/events.db` (SQLite, WAL mode; `$SHIBAOX_HOME` moves the
directory), written only by the daemon. `shibaox replay <runId> --db <path>` reads a
database offline, including the per-org `<org>/.shibaox/events.db` files of earlier phases.
Deleting the file deletes the run history. Run worktrees live under
`<project>/.shibaox/worktrees/`, run notes in the vault.

## Layout

| Path | What it holds |
| --- | --- |
| `packages/schemas` | zod schemas for org, teams, roles, gates, workflows, events; `loadOrg` |
| `packages/core` | event store interface, reducer/replay, scheduler, executors, gate engine, `RunEngine` |
| `packages/persistence-sqlite` | `SqliteEventStore` |
| `packages/providers` | provider catalog, `ProviderRegistry`, `LlmClient`, judge check runner, lead decider |
| `packages/jev` | Jev client, `JevDecider`, `jev` check runner |
| `packages/adapter-direct` | `DirectAdapter`: AI SDK agent loop with workspace-scoped tools |
| `packages/adapter-claude-code` | `ClaudeCodeAdapter`: Claude Agent SDK runtime, role tool rules, human approvals |
| `packages/workspace` | git worktree per run: create, list, remove, diff |
| `packages/memory` | vault run/decision notes, `Graphify` runner and MCP config |
| `packages/daemon` | the local daemon: run manager (queue, restart recovery), inbox, socket API + client, channels, schedules, and the runtime wiring |
| `apps/tui` | the OpenTUI + Solid dashboard (Bun; `runDashboard`, `runStream`), a pure client of the daemon socket API; motion and dialog primitives adapted from opencode (MIT, see `apps/tui/THIRD_PARTY.md`) |
| `apps/cli` | `shibaox [ui] / init / doctor / daemon / run / follow / runs / replay / resume / cancel / inbox / approve / deny / schedule / providers / models / graph / worktree` |
| `examples/sample-repo` | a tiny Node project used by the sample workflow and the e2e tests |
| `docs/superpowers/specs` | the design spec |
