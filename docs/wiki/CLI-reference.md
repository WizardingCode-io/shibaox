# CLI reference

`shibaox` with no command opens the [Dashboard](Dashboard). Every command takes `--json` (one JSON object per line), `--remote <url>` (a daemon on another machine, see [Remote daemon](Remote-daemon)) and `--help`.

## Runs

| Command | |
| --- | --- |
| `shibaox run <workflow> [--org <dir>] [--project <dir>] [--input <text>] [--issue <n\|url>] [--model <ref>] [--adapter mock\|direct\|claude-code] [--workspace worktree\|inplace] [--budget <usd>] [--graph auto\|off] [--setup auto\|off\|<command>] [--detach]` | submits a run and follows it (`--detach` returns at once). `--issue` makes a GitHub issue the request and reports back on it ([GitHub loop](GitHub-loop)). A worktree run installs the project's dependencies first (`--setup`: `shibaox.yaml setup` or the lockfile's install by default, `off`, or a command). The org is `./org` when it exists, else the daemon's default org; the project is the current directory. Exit 0 when the run completes, 2 otherwise. |
| `shibaox runs` | every run the daemon knows |
| `shibaox follow <runId>` | the run view (or plain lines) of a run |
| `shibaox replay <runId> [--db <path>]` | the event log and the derived state |
| `shibaox files <runId> [path] [--out <file>]` | the files a run created or changed (status, size, lines); with a path, that file to stdout (text) or saved with `--out` (binaries too); never a protected file (`.env`, `.git`, the project's `protected:` globs) |
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
| `shibaox keys list\|set <NAME> [value]\|unset <NAME>` | the key vault (value from stdin when omitted); a value the daemon refuses (`HIGGSFIELD_API_KEY` without its colon) prints why and exits 1 |
| `shibaox mcp list [--org <dir>]`, `shibaox mcp test <id> [--org <dir>]` | the catalog's MCP servers (roles, keys), and a start-and-list check of one on the daemon |
| `shibaox mcp add <id> (--url <https> \| --command <cmd> [--arg …]) [--key NAME…] [--header K=V…] [--bearer-command <arg>…] [--tool …] [--role …] [--description …] [--timeout <ms>] [--replace] [--org <dir>]`, `shibaox mcp rm <id> [--org <dir>]` | writes `catalog/<id>.yaml` and gives it to roles (refused when the id exists, unless `--replace`; `--bearer-command` takes one argument per flag); `rm` takes it off every role first ([MCP and skills](MCP-and-skills)) |
| `shibaox skills list [--org <dir>]`, `shibaox skills add <owner/repo[/path] \| git URL \| ./dir \| /dir \| ~/dir> [--folder] [--id <id>…] [--path <p>] [--org <dir>]`, `shibaox skills add <id> --builtin [--replace]`, `shibaox skills rm <id> [--detach] [--org <dir>]` | the org's skills: install from a repository (shallow clone; `github.com/` in front is fine) or a folder (a source starting with `.`, `/` or `~`, or `--folder`), existing ids skipped; `--builtin` copies a skill shipped with Shibaox (`higgsfield`, `higgsfield-app`), `--replace` rewrites its `SKILL.md`; `rm` is refused while a role uses the skill unless `--detach` |
| `shibaox roles list [--org <dir>]` | each role's model, MCP servers and skills |
| `shibaox plugins` | Higgsfield, GitHub, Telegram, TypeSafe / Jev: each check, and `ready`, `partial` or `off`; Higgsfield shows its mode (`mode auto → api`) and both modes (`[api] active ready`) with their checks |
| `shibaox plugins higgsfield-mode <auto\|account\|api>` | how Higgsfield generates (`partners.higgsfield.mode` in `daemon.yaml`); the next task uses it |
| `shibaox providers list [--configured]`, `shibaox providers test <provider> [--model <m>]` | the catalog and a real test call |
| `shibaox models --org <dir>` | how each role of the org resolves to a model |

## Daemon

| Command | |
| --- | --- |
| `shibaox app [--no-open] [--port <n>]` | the browser app: opens it against this daemon (or a remote one); a socket-only daemon gets a loopback bridge that lives while the command runs ([The app](App)) |


| Command | |
| --- | --- |
| `shibaox daemon start [--detach]`, `status`, `stop [--force]` | the daemon |
| `shibaox daemon install`, `uninstall` | the service: launchd (macOS) or `systemd --user` (Linux) |
| `shibaox serve [--host <addr>] [--port <n>]` | the daemon in the foreground, reachable over the network with the token in `SHIBAOX_DAEMON_TOKEN` (vault or environment) |
| `shibaox remote set <url> [token]`, `show`, `clear` | send every command to a daemon on another machine (`~/.shibaox/remote.json`, 0600; the token from stdin when omitted) |
| `shibaox routine add <workflow> --on <trigger> --org <dir> --project <path> [--input] [--name] [--description] [--model <ref>] [--approvals inbox\|auto\|skip] [--label] [--repo] [--branch] [--every <s>] [--mode always\|on_change] [--max-daily <usd>] [--adapter] [--budget]`, `update <id> [the same flags except --org; "" clears a field]`, `list`, `show <id>`, `run <id>`, `pause <id>`, `resume <id>`, `rm <id>`, `sync --org <dir>` | what the daemon does on its own: `--on cron:<expr>`, `github:issues\|prs\|checks`, `url:<https://…>`, `file:<path>`, `command:<cmd>`, `manual`; `show` says when it runs next and how its last run went; see [Routines](Routines) |
| `shibaox schedule add "<cron>" <workflow> [--org] [--project] [--input]`, `list`, `rm <id>`, `run <id>` | the cron subset of routines, under its older name |
| `shibaox doctor` | prerequisites, the daemon, the service, the install, who decides (the home org's decision tier and whether it is usable), Higgsfield (the CLI, the account, the credits; `higgsfield api`: the key and whether Higgsfield accepts it, and the mode; a `higgsfield skill` warning when the org's skill predates the API mode), keys, Telegram, the Claude login |
| `shibaox upgrade` | updates an installer checkout and restarts the daemon |

## Project

| Command | |
| --- | --- |
| `shibaox worktree list --project <dir>`, `shibaox worktree rm <runId> --project <dir> [--delete-branch]` | run worktrees |
| `shibaox graph build\|update\|query "<question>" --project <dir>` | the graphify knowledge graph |
