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

## Signing and notarizing the macOS app

The desktop workflow (`.github/workflows/desktop.yml`) signs the app with a Developer ID and notarizes it when five repository secrets exist; without them it signs ad hoc, and macOS asks for "Open Anyway" once. To set them up (once, an [Apple Developer](https://developer.apple.com/programs/) membership is required):

1. **Certificate.** In Xcode (Settings → Accounts → Manage Certificates) or at developer.apple.com/account/resources/certificates, create a **Developer ID Application** certificate. In Keychain Access, export it (with its private key) as a `.p12` with a password, then `base64 -i cert.p12 | pbcopy`.
   - `APPLE_CERTIFICATE_P12`: the base64 of the `.p12`.
   - `APPLE_CERTIFICATE_PASSWORD`: its password.
2. **Notarization key.** At [App Store Connect → Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api), create a **Team key** with the **Developer** role and download the `.p8` (it downloads once).
   - `APPLE_API_KEY_ID`: the key's ID.
   - `APPLE_API_ISSUER`: the issuer ID shown on that page.
   - `APPLE_API_KEY_P8`: the contents of the `.p8` file.
3. Add the five secrets at Settings → Secrets and variables → Actions of the repository, then re-run the desktop workflow for the tag (`gh workflow run desktop.yml -f tag=v0.2.3`): it replaces the dmg on the release with the notarized one, and adds the update files (below). A re-run on a release that is already published goes live at once.

`spctl --assess --type execute Shibaox.app` says `accepted` on a notarized build. Locally, `pnpm --filter @wizardingcode/shibaox-desktop dist` keeps signing ad hoc (no certificate needed).

**Updates.** Installed apps update themselves with `electron-updater` from the GitHub releases: the workflow attaches, next to the dmg, the zip of each architecture, its blockmap and `latest-mac.yml`. The updater only sees published releases (never drafts or pre-releases), so an update goes out when the draft release of the tag is published. Only a Developer ID build can update installed apps: an ad-hoc build (`pnpm dist`, a workflow run without the Apple secrets) is packaged with `shibaoxUpdates: false` and never checks, and the workflow attaches only its dmg. What the updater did is appended to `~/.shibaox/desktop.log`.
