# Development

A pnpm 10 + turborepo monorepo, TypeScript strict, zod 4, vitest, `bun test` for the dashboard, biome.

```sh
git clone https://github.com/WizardingCode-io/shibaox.git && cd shibaox
pnpm install
pnpm build            # every package (tsc; the dashboard is bundled with Bun)
pnpm test             # vitest per package, bun test for apps/tui
pnpm lint             # biome (0 errors; a few accepted warnings)
node apps/cli/dist/index.js --help
```

## Layout

| Path | npm name | What it holds |
| --- | --- | --- |
| `packages/schemas` | `@wizardingcode/shibaox-schemas` | zod schemas for org, teams, roles, gates, workflows, events; `loadOrg` |
| `packages/core` | `@wizardingcode/shibaox-core` | event store interface, reducer/replay, scheduler, executors (code, git, mock), gate engine, conversation compaction, `RunEngine` |
| `packages/persistence-sqlite` | `@wizardingcode/shibaox-persistence-sqlite` | `SqliteEventStore` |
| `packages/providers` | `@wizardingcode/shibaox-providers` | provider catalog, `ProviderRegistry`, discovery (prices, windows), `LlmClient`, judge and review runners, lead decider |
| `packages/jev` | `@wizardingcode/shibaox-jev` | Jev client, `JevDecider`, `jev` check runner |
| `packages/adapter-direct` | `@wizardingcode/shibaox-adapter-direct` | the direct agent loop: streaming, tools, text-written tool calls |
| `packages/adapter-claude-code` | `@wizardingcode/shibaox-adapter-claude-code` | the Claude Agent SDK runtime, tool rules, approvals |
| `packages/workspace` | `@wizardingcode/shibaox-workspace` | git worktree per run: create, list, remove, diff |
| `packages/memory` | `@wizardingcode/shibaox-memory` | vault notes, `Graphify` runner and MCP config |
| `packages/bridge` | `@wizardingcode/shibaox-bridge` | the loopback bridge and the static server of the browser app (no dependencies: shared by the daemon, the CLI and the desktop app) |
| `packages/daemon` | `@wizardingcode/shibaox-daemon` | the daemon: run manager, inbox, socket API and client, channels, schedules, key vault, org config, service, runtime wiring |
| `apps/tui` | `@wizardingcode/shibaox-tui` | the OpenTUI + Solid dashboard (Bun); published as built JavaScript |
| `apps/app` | `@wizardingcode/shibaox-app` | the browser app (React 18 + Vite on the design system), served by the daemon under `/app` |
| `apps/desktop` | (private) | the macOS app: Electron main process bundled by esbuild, dmg by electron-builder (`pnpm --filter @wizardingcode/shibaox-desktop dist`) |
| `apps/cli` | `shibaox` | the CLI: `shibaox [ui] / init / doctor / daemon / run / … / upgrade` |
| `examples/sample-repo` | | a tiny Node project used by the sample workflow and the e2e tests |
| `docs/wiki` | | this wiki's source |

## How work is done

Each feature: a short spec, tests first (watched failing), the implementation, a review by a fresh reviewer, one fix pass, a merge to `main`, a live check against the running daemon. The dashboard's tests render the app in a fake terminal; the daemon's tests run real git repositories, a fake OpenAI-compatible server, a fake Telegram API and a fake `gh`.

Gotchas: a focused `<input>` in the dashboard must be mounted on the next tick (`setTimeout(0)`), or the key that opened it lands inside; tests under load poll frames for streamed text; OpenTUI's Solid transform skips files under `node_modules`, which is why the published dashboard is a Bun bundle; `git clone` takes committed content only when testing the installer from a local clone.

## Releasing

Every package shares one version. Bump them, build, then from the root:

```sh
pnpm -r publish --access public --no-git-checks
```

pnpm rewrites `workspace:*` to the version. The installer (`scripts/install.sh`) installs from GitHub `main` (or `SHIBAOX_REF`).
