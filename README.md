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
`budgets.per_run_usd` in `org/org.yaml`) and `--db <path>`.

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
| `TYPESAFE_API_KEY` | Jev: `decide` nodes and `jev` gate checks. Without it `jev` checks fail. |
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

`anthropic-subscription/...` runs through the Claude Code runtime, which arrives in phase
1B-2; with the direct adapter it fails with a clear message. `shibaox run` picks the
direct adapter when the `strong` tier resolves to a configured provider, and the mock
adapter (with a `warn:` line) otherwise; `--adapter mock|direct` forces one.

### Local models

Ollama (`ollama serve`, port 11434) and LM Studio (port 1234) need no key:

```sh
ollama pull qwen2.5-coder:7b
# in org/models.yaml: strong: ollama/qwen2.5-coder:7b   (or lmstudio/<model>)
shibaox providers test ollama --model qwen2.5-coder:7b
shibaox run hello-feature --org ./org --project ./project --input "..." --adapter direct
```

Local models have no pricing in the catalog, so their runs report `spent=$0`.

### Tool safety

The direct adapter gives a role the tools `list_files`, `read_file`, `write_file`,
`run_command` and `finish`, confined to the workspace. `run_command` only runs the programs
listed in the role's `tools:` (for example `[git, node, pnpm]`), without a shell and with a
scrubbed environment. This is an **allowlist, not a sandbox**: an allowed program such as
`node` or `pnpm` can still run arbitrary code with your user's permissions. Run it on
projects and machines where that is acceptable.

## Where state lives

Events are stored in `<org>/.shibaox/events.db` (SQLite, WAL mode) unless `--db` points
elsewhere. `shibaox init` writes `org/.gitignore` with `.shibaox/`, so the database is
never committed with the org repo. Deleting the file deletes the run history.

## Layout

| Path | What it holds |
| --- | --- |
| `packages/schemas` | zod schemas for org, teams, roles, gates, workflows, events; `loadOrg` |
| `packages/core` | event store interface, reducer/replay, scheduler, executors, gate engine, `RunEngine` |
| `packages/persistence-sqlite` | `SqliteEventStore` |
| `packages/providers` | provider catalog, `ProviderRegistry`, `LlmClient`, judge check runner, lead decider |
| `packages/jev` | Jev client, `JevDecider`, `jev` check runner |
| `packages/adapter-direct` | `DirectAdapter`: AI SDK agent loop with workspace-scoped tools |
| `apps/cli` | `shibaox init / doctor / run / runs / replay / resume / providers / models` |
| `examples/sample-repo` | a tiny Node project used by the sample workflow and the e2e tests |
| `docs/superpowers/specs` | the design spec |
