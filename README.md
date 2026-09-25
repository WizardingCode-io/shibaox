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
| `apps/cli` | `shibaox init / doctor / run / runs / replay / resume` |
| `examples/sample-repo` | a tiny Node project used by the sample workflow and the e2e tests |
| `docs/superpowers/specs` | the design spec |
