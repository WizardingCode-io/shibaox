# Troubleshooting

Start with `shibaox doctor`: it checks Node, git, Bun, the install, the daemon (and whether it is older than the CLI), the service, the keys, Telegram and the Claude login, and says what to do.

## The daemon

- **"No shibaox daemon is running"** — any command starts it on demand; `SHIBAOX_NO_AUTOSTART=1` prevents that. `shibaox daemon start` in the foreground shows why it fails to start; `~/.shibaox/daemon.log` keeps the output of the service.
- **"Daemon … is older than this CLI"** — `shibaox daemon stop`; the service (or the next command) starts the new build.
- **The service keeps restarting** — `tail ~/.shibaox/daemon.log`. After a Node upgrade the launcher says `the recorded node … is gone` or `is not the same ABI`: run `shibaox daemon install` again. `daemon status` and `doctor` say when this is due.

## Native modules and Node

- **`better-sqlite3` fails to build or load** — a Node version other than the one it was built for. Installer checkout: `shibaox upgrade` (or `cd ~/.shibaox/app && pnpm rebuild better-sqlite3`). npm: `npm i -g shibaox@latest`. Without a prebuilt binary you need a toolchain (`xcode-select --install`) and `npm i -g node-gyp`.
- **The launcher says the Node on the PATH has a different ABI** — it still runs the CLI, but the daemon will fail on native modules: rebuild as above.

## The dashboard

- **"The dashboard needs Bun 1.3 or later"** — install it from https://bun.sh; the text commands work meanwhile (`shibaox runs`, `inbox`, `follow --json`).
- **"The dashboard needs an interactive terminal"** — run it in a terminal, not through a pipe.
- **"finding the org…" stays** — the daemon did not answer for the default org; `shibaox daemon status` and `daemon.log`.

## Models

- **"model … is not offered by <provider>"** — the provider's own listing does not have that name; `/model` in the dashboard shows what it lists.
- **"cannot start: role … → provider … is not configured"** — the role's tier points at a provider without a key: `shibaox keys set <KEY>`, or change the tier (`shibaox tiers set strong …`).
- **A run costs $0 or has no context percentage** — the model has no known price or window (a hosted provider without a listing). OpenRouter and local models are discovered; others use the catalog.
- **Decide nodes always pick `ship`, judge and review checks fail** — no callable decision model: set `tiers.decision` to a model ref another provider serves (for example `openrouter/typesafe/jev-router`) or `TYPESAFE_API_KEY`. Subscription-only orgs cannot call models from the daemon.

## Runs

- **"cannot use a worktree: project has no commits"** — commit first, or `--workspace inplace`.
- **`paused_budget`** — `shibaox resume <runId> --budget <higher>`.
- **The merge failed with "rebase … failed (conflicts)"** — the base moved with conflicting changes; the branch is intact in its worktree, the base untouched. Resolve by hand or rerun.
- **Tests or lint fail in a worktree with "command not found"** — the tool is not installed there; the `tests` and `lint` checks treat that as a skipped pass, the `merge` node's tests too.## Telegram

- **The bot does not answer** — `shibaox doctor` runs `getMe`; the token must be in the vault (`shibaox keys set SHIBAOX_TELEGRAM_TOKEN …`) and `chat_id` must be your private chat. Groups are ignored.
- **A message sent while the daemon was down was skipped** — by design: only the last of the backlog is answered, and the chat is told.
