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

# 3. Run the hello-feature workflow against a copy of the sample repo.
cp -R <path-to-shibaox>/examples/sample-repo ./project
shibaox run hello-feature --org ./org --project ./project --input "add /health"
```

`hello-feature` runs `analyse → implement → qa (gate: npm test) → judge (decide) → ship
(human)`. In an interactive terminal the `ship` node asks `Approve the push? (y/n)`.
Without a TTY (CI, `< /dev/null`) the question is deferred: the run stops with
`status=waiting_human` and exit code 2. Other useful flags: `--budget <usd>` (defaults to
`budgets.per_run_usd` in `org/org.yaml`), `--db <path>`, `--workspace` and `--graph` (see
[Worktrees](#worktrees) and [Memory](#memory-vault--graphify)). The copied project is not a
git repository, so this run works in place; in a git repository it runs in a worktree.

```sh
# 4. List runs, then replay one run's event log and its derived state.
shibaox runs --org ./org
shibaox replay <runId> --org ./org

# 5. Continue a run: answer pending humans, lift a budget pause, or re-run nodes
#    interrupted by a crash. Exit code 0 when the run completes, 2 otherwise.
shibaox resume <runId> --org ./org
shibaox resume <runId> --org ./org --budget 10   # required after a budget pause
```

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

### Environment variables

Each provider reads its key from the variable shown by `providers list` (for example
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `OPENAI_API_KEY`). Others:

| Variable | Used for |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev: `decide` nodes and `jev` gate checks. Without it `jev` checks fail. `shibaox init` ships the `spec` jev check in `org/gates/tests.yaml` commented out; uncomment it once the key is set. |
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
- **`approval_required` without a TTY.** Approvals are asked through the terminal. Without
  a TTY the question is deferred, and a Claude Code task that needs a push/deploy approval
  **fails** (`approval pending for push: ...`): Claude Code cannot wait across processes in
  this phase. Run interactively, or keep approval-gated actions out of Claude Code tasks
  (for example, leave the push to a `human` node).
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

Events are stored in `<org>/.shibaox/events.db` (SQLite, WAL mode) unless `--db` points
elsewhere. `shibaox init` writes `org/.gitignore` with `.shibaox/`, so the database is
never committed with the org repo. Deleting the file deletes the run history. Run
worktrees live under `<project>/.shibaox/worktrees/`, run notes in the vault.

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
| `apps/cli` | `shibaox init / doctor / run / runs / replay / resume / providers / models / graph / worktree` |
| `examples/sample-repo` | a tiny Node project used by the sample workflow and the e2e tests |
| `docs/superpowers/specs` | the design spec |
