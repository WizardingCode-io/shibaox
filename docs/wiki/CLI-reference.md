# CLI reference

`shibaox` with no command opens the [Dashboard](Dashboard). Every command takes `--json` (one JSON object per line), `--remote <url>` (a daemon on another machine, see [Remote daemon](Remote-daemon)) and `--help`.

## Runs

| Command | |
| --- | --- |
| `shibaox run <workflow> [--org <dir>] [--project <dir>] [--input <text>] [--issue <n\|url>] [--model <ref>] [--adapter mock\|direct\|claude-code] [--workspace worktree\|inplace] [--budget <usd>] [--graph auto\|off] [--setup auto\|off\|<command>] [--detach]` | submits a run and follows it (`--detach` returns at once). `--issue` makes a GitHub issue the request and reports back on it ([GitHub loop](GitHub-loop)). A worktree run installs the project's dependencies first (`--setup`: `shibaox.yaml setup` or the lockfile's install by default, `off`, or a command). The org is `./org` when it exists, else the daemon's default org; the project is the current directory. Exit 0 when the run completes, 2 otherwise. |
| `shibaox runs` | every run the daemon knows |
| `shibaox follow <runId>` | the run view (or plain lines) of a run |
| `shibaox replay <runId> [--db <path>]` | the event log and the derived state |
| `shibaox audit <runId> [--format md\|json] [--out <file>]` | everything that happened in a run: request, nodes with attempts and tool calls (with durations), gates with evidence, decisions, who approved what through which channel, git results, cost per node |
| `shibaox runs prune --before <30d\|12h\|45m\|ISO>` | removes finished runs older than that, with their events and tool calls; a run whose task is still out stays; worktrees and `shibaox/<runId>` branches are not touched (`shibaox worktree rm`) |
| `shibaox resume <runId> [--budget <usd>] [--adapter …]` | continues a paused or interrupted run |
| `shibaox cancel <runId>` | cancels a run |
| `shibaox steer <runId> <note…> [--node <id>]` | redirects the running task: it stops and starts again with the note (the node when several tasks run at once); only a task with a live model call can be steered |

## Approvals and inbox

| Command | |
| --- | --- |
| `shibaox inbox` | what waits for you: `human:<runId>:<node>` and `approval:<id>` |
| `shibaox approve <id> [--note <text>]`, `shibaox deny <id> [--note <text>]` | answer one item; the first answer wins |

## Org and models

| Command | |
| --- | --- |
| `shibaox init [dir] [--stack node\|python\|php-laravel\|go\|auto]` | scaffolds `org/` and `vault/`; with a stack also `shibaox.yaml` (setup, tests, lint, typecheck, protected), `typecheck` and stack `review` gates, a weekly `security-scan` workflow + routine, and (node) a `frontend` role; `auto` reads the stack off the project's manifest |
| `shibaox tiers [--org <dir>]`, `shibaox tiers set <strong\|cheap\|decision\|judge\|adapter\|budget> <value>` | the org's tiers, judge, adapter and budget (`none` clears judge/adapter) |
| `shibaox keys list\|set <NAME> [value]\|unset <NAME>` | the key vault (value from stdin when omitted) |
| `shibaox mcp list [--org <dir>]`, `shibaox mcp test <id> [--org <dir>]` | the catalog's MCP servers (roles, keys), and a start-and-list check of one on the daemon |
| `shibaox providers list [--configured]`, `shibaox providers test <provider> [--model <m>]` | the catalog and a real test call |
| `shibaox models --org <dir>` | how each role of the org resolves to a model |

## Daemon

| Command | |
| --- | --- |
| `shibaox daemon start [--detach]`, `status`, `stop [--force]` | the daemon |
| `shibaox daemon install`, `uninstall` | the service: launchd (macOS) or `systemd --user` (Linux) |
| `shibaox serve [--host <addr>] [--port <n>]` | the daemon in the foreground, reachable over the network with the token in `SHIBAOX_DAEMON_TOKEN` (vault or environment) |
| `shibaox remote set <url> [token]`, `show`, `clear` | send every command to a daemon on another machine (`~/.shibaox/remote.json`, 0600; the token from stdin when omitted) |
| `shibaox routine add <workflow> --on <trigger> --org <dir> --project <path> [--input] [--name] [--label] [--repo] [--branch] [--every <s>] [--mode always\|on_change] [--max-daily <usd>] [--adapter] [--budget]`, `list`, `show <id>`, `run <id>`, `pause <id>`, `resume <id>`, `rm <id>`, `sync --org <dir>` | what the daemon does on its own: `--on cron:<expr>`, `github:issues\|prs\|checks`, `url:<https://…>`, `file:<path>`, `command:<cmd>`; see [Routines](Routines) |
| `shibaox schedule add "<cron>" <workflow> [--org] [--project] [--input]`, `list`, `rm <id>`, `run <id>` | the cron subset of routines, under its older name |
| `shibaox doctor` | prerequisites, the daemon, the service, the install, keys, Telegram, the Claude login |
| `shibaox upgrade` | updates an installer checkout and restarts the daemon |

## Project

| Command | |
| --- | --- |
| `shibaox worktree list --project <dir>`, `shibaox worktree rm <runId> --project <dir> [--delete-branch]` | run worktrees |
| `shibaox graph build\|update\|query "<question>" --project <dir>` | the graphify knowledge graph |
