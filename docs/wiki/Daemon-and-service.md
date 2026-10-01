# Daemon and service

Runs execute inside a per-user daemon (`~/.shibaox/`, or `$SHIBAOX_HOME`): closing the terminal never kills a run, and approvals wait in a persistent inbox. Any command that needs the daemon starts it in the background and says so (`SHIBAOX_NO_AUTOSTART=1` disables that). The daemon can also run on another machine and be reached with a token: see [Remote daemon](Remote-daemon).

```sh
shibaox daemon start --detach   # or in the foreground: shibaox daemon start
shibaox daemon status
shibaox daemon stop             # waits for active runs (60 s, then they resume at the next start); --force cancels them
shibaox daemon install          # a launchd agent (macOS) or a systemd user unit (Linux) starts it at login and restarts it
shibaox daemon uninstall
shibaox serve                   # the daemon in the foreground, reachable over the network with a token
```

## The service (Linux)

`daemon install` writes `~/.config/systemd/user/shibaox.service` (`ExecStart` is the launcher below, `Restart=always`, output to `daemon.log`, needs systemd 240 or later) and runs `systemctl --user enable --now shibaox.service`. `loginctl enable-linger $USER` keeps a user service running with nobody logged in. The unit records the `PATH` of the shell that installed it (so nvm's node and the tools next to it are found) and nothing else of your shell's environment: keys belong in the vault. `shibaox daemon install` again after changing that PATH.

## The service (macOS)

`daemon install` writes `~/Library/LaunchAgents/io.shibaox.daemon.plist` and loads it: the daemon starts now and at every login, and launchd restarts it if it exits. The agent runs through `/bin/zsh -lc`, so it gets a **login** shell's environment: exports in `~/.zprofile` or `~/.zshenv` reach it, exports only in `~/.zshrc` do not (`daemon install` checks the keys your shell has and says which ones the service would miss). Keys in the vault reach it whatever the shell exports.

The plist runs `~/.shibaox/daemon.sh`, a launcher that records the `node` and CLI paths of the install. When either moved (a Node upgrade under nvm or brew), it falls back to the login shell's `node` only when it has the same ABI (native modules were built for it) and to `shibaox` on the PATH; otherwise it says why in `daemon.log` and waits, and `daemon status` and `doctor` tell you a `daemon install` is due.

## Files

`daemon.sock` (0600, HTTP JSON + SSE, no authentication: only your user reaches it), `daemon.pid`, `daemon.log`, `daemon.yaml`, `events.db` (one SQLite database for every org and project you run: the run events and, since 0.1.8, every runtime event — tool calls, texts, usage — so the dashboard and `shibaox audit` show them after a restart; `shibaox runs prune --before 30d` trims it; worktrees stay until `shibaox worktree rm`), `secrets.json` (the key vault), `org/` (the default org), `workspace/` (where the orchestrator works when no project is chosen), `ui.json` (dashboard preferences), `remote.json` (0600, the remote daemon and its token when one is set).

## Inbox

`shibaox inbox` lists human nodes (`human:<runId>:<node>`) and tool approvals (`approval:<id>`, a push or deploy asked by a task). `approve` and `deny` answer them, with an optional `--note`. The first answer wins. An approval applies to that exact command on that node: the task never asks twice for the same command.

## Sessions

While a Claude Code task waits for an approval its session stays open. After `approval_timeout_minutes` (default 120), or when the daemon restarts, the task is suspended and resumed by session id once you answer, with a note saying what was decided.

## Concurrency

`max_concurrent_runs` in `daemon.yaml` (default 4) and in `org.yaml` (default 2); runs above the limits wait as `queued`. Merges go one at a time per project.

## Routines

Cron schedules, GitHub issues, pull requests and checks, a URL, a file or a command wake the daemon up and submit runs: see [Routines](Routines). `shibaox schedule …` is the cron subset under its older name.

## Reports

A run asked for by a routine or from Telegram carries an `origin` (runs it dispatches inherit it). When it ends, a report goes through the outbox to every channel that shows reports: Telegram gets `✓ hello-feature done · 5 nodes · $0.12 · 8m 42s · branch …` plus one line per node, what still needs you, the error and the vault note path; macOS gets a notification. A conversation run reports its reply only.

## Model discovery

At start and after a key changes, the daemon asks the providers what they offer (prices, context windows, what a local server has loaded) and every run waits for that answer before it starts, so cost and context are right from the first turn. See [Providers and models](Providers-and-models).

## The API

Everything the CLI and the dashboard do goes through the socket: `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events` (SSE), `GET /runs/:id/audit[?format=md]`, `GET /runs/:id/files`, `GET /runs/:id/files/content?path=[&download=1]`, `PUT /runs/:id/files/content?path=` (body `{content}`; 403/404/409/413), `POST /runs/:id/steer` (409 when no task is running), `GET /runs?parent=|thread=`, `POST /runs/prune`, `/inbox`, `/keys`, `GET /mcp?org=`, `POST /mcp/:id/test?org=`, `GET /app/*` (the browser app, no token), `/models`, `GET /decisions[?limit=]` (who decides and the latest decisions), `GET /integrations/higgsfield` (the CLI, the account, the MCP), `POST /integrations/higgsfield/login` (the browser login; socket and loopback only), `/orgs/default`, `/orgs/info`, `/orgs/config`, `/projects`, `/projects/profile`, `/routines`, `/schedules` (the cron subset), `/health`, `/shutdown`. On the socket it is unauthenticated by design (0600, local). With `listen` in `daemon.yaml` the same API answers on TCP with a bearer token: [Remote daemon](Remote-daemon).
