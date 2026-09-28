# CLI reference

`shibaox` with no command opens the [Dashboard](Dashboard). Every command takes `--json` (one JSON object per line) and `--help`.

## Runs

| Command | |
| --- | --- |
| `shibaox run <workflow> [--org <dir>] [--project <dir>] [--input <text>] [--model <ref>] [--adapter mock\|direct\|claude-code] [--workspace worktree\|inplace] [--budget <usd>] [--graph auto\|off] [--detach]` | submits a run and follows it (`--detach` returns at once). The org is `./org` when it exists, else the daemon's default org; the project is the current directory. Exit 0 when the run completes, 2 otherwise. |
| `shibaox runs` | every run the daemon knows |
| `shibaox follow <runId>` | the run view (or plain lines) of a run |
| `shibaox replay <runId> [--db <path>]` | the event log and the derived state |
| `shibaox resume <runId> [--budget <usd>] [--adapter …]` | continues a paused or interrupted run |
| `shibaox cancel <runId>` | cancels a run |

## Approvals and inbox

| Command | |
| --- | --- |
| `shibaox inbox` | what waits for you: `human:<runId>:<node>` and `approval:<id>` |
| `shibaox approve <id> [--note <text>]`, `shibaox deny <id> [--note <text>]` | answer one item; the first answer wins |

## Org and models

| Command | |
| --- | --- |
| `shibaox init [dir]` | scaffolds `org/` and `vault/` |
| `shibaox tiers [--org <dir>]`, `shibaox tiers set <strong\|cheap\|decision\|judge\|adapter\|budget> <value>` | the org's tiers, judge, adapter and budget (`none` clears judge/adapter) |
| `shibaox keys list\|set <NAME> [value]\|unset <NAME>` | the key vault (value from stdin when omitted) |
| `shibaox providers list [--configured]`, `shibaox providers test <provider> [--model <m>]` | the catalog and a real test call |
| `shibaox models --org <dir>` | how each role of the org resolves to a model |

## Daemon

| Command | |
| --- | --- |
| `shibaox daemon start [--detach]`, `status`, `stop [--force]` | the daemon |
| `shibaox daemon install`, `uninstall` | the launchd service (macOS) |
| `shibaox schedule add "<cron>" <workflow> [--org] [--project] [--input]`, `list`, `rm <id>`, `run <id>` | cron schedules |
| `shibaox doctor` | prerequisites, the daemon, the service, the install, keys, Telegram, the Claude login |
| `shibaox upgrade` | updates an installer checkout and restarts the daemon |

## Project

| Command | |
| --- | --- |
| `shibaox worktree list --project <dir>`, `shibaox worktree rm <runId> --project <dir> [--delete-branch]` | run worktrees |
| `shibaox graph build\|update\|query "<question>" --project <dir>` | the graphify knowledge graph |
