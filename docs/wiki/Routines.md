# Routines

A routine is what the daemon does on its own: on a schedule, or when something it watches changes. "Every weekday at nine, tell me what changed", "when an issue gets the `bug` label, open a fix", "when the CI of `main` goes red, look into it". A routine submits a run of a workflow with an input; the run reports where reports go (Telegram, macOS) and lands like any other.

## Triggers

| Trigger | Fires |
| --- | --- |
| `cron: "0 9 * * 1-5"` | on each occurrence (mode `always`) |
| `github: issues` (`label`, `repo`) | when the set of open issues with that label changes: a new one, one closed (`gh issue list`); comments and edits do not count |
| `github: prs` (`label`, `repo`) | when the set of open pull requests changes |
| `github: checks` (`branch`, `repo`) | when the latest completed run of a workflow on the branch (the repository's default branch unless given) is red; cancelled and skipped runs are ignored; a green branch never fires |
| `url: https://…` | when the page's status or body changes (public http(s) addresses only; 20 s, the first 64 KB) |
| `file: ./path` | when the file appears, grows or is modified (relative to the org in a file, to the project on the command line) |
| `command: git status --porcelain` | when the command's exit code or output changes (stdout and stderr, so a command that prints a timestamp fires every look) |

Watchers look every `every` seconds (default 120, at least 30) and fire in mode `on_change` (the default for them) when the fingerprint of what they saw differs from the last time they fired; the first look fires when there is something to act on. `mode: always` fires at every look. `repo` defaults to the project's `origin` remote on GitHub. What the trigger saw goes into the run's input, fenced and marked as data, never as instructions, capped at a few KB; a run should still treat issue titles and page contents with the same suspicion as anything else it reads. `gh` runs with the `GH_TOKEN` of the vault.

## Manual routines

`on: { manual: true }` (`--on manual`, or **Frequency: Manual** in the app) is a routine that never fires on its own: a task kept ready, run from the app, the CLI (`shibaox routine run <id>`) or Telegram whenever you want it, with its instructions, model and policy saved.

## Approvals per routine

A routine says how its runs handle approvals (`approvals`, **Permissions** in the app):

- `inbox` (default): a push, a deploy, a command with inline code, a network call or a protected file waits for you in the inbox, as in any run.
- `auto`: those tool approvals are answered by Shibaox itself; the workflow's human steps (`approve-push`, `approve-merge`…) still wait for you.
- `skip`: nothing waits, human steps included. The run never pauses.

The policy travels to every run the routine's run dispatches, and is written on each run (`shibaox audit` shows "Approvals: auto"). `auto` and `skip` are for work you would let run while you sleep; a routine from the org files carries the same field.

## Guards

A routine never fires while a run it started is still active, and a change seen meanwhile is not lost: it fires once the run ends. `max_daily_usd` stops it for the day (UTC) once its runs have spent that much; watchers get a cap of $10 a day unless you set one, because a busy repository would otherwise start a run every few minutes. `shibaox routine pause` and `resume` switch it off and on; `run` fires it now, whatever the trigger says (never twice at once).

`command` and `file` triggers run or read on the daemon's machine with the daemon's rights: they are added from that machine (the socket) or from `org/routines` files, never over the network by a remote client; `url` triggers take public addresses only, never the daemon's own host or a private network.

## Continuity

Every run of a routine leaves one line in `90-system/routines/<id>.md` in the org's vault (when the org has one): the date, the run, its status, its cost and the first line of its outcome. The last ten lines go into the next run's input under "Previous runs of this routine", so a routine remembers what it found yesterday.

## Routines as code

`org/routines/<id>.yaml` in the org, loaded with `shibaox routine sync --org ./org` (`shibaox init --stack` writes `security-scan.yaml`: a weekly dependency audit on a cron):

```yaml
routine: bugs                 # the id
name: Fix labelled bugs
on: { github: issues, label: bug }
workflow: fix-issue
input: Fix the issue described below. Open a pull request.
project: ../app               # relative to the org directory (default: its parent)
every: 300                    # seconds between looks (watchers)
mode: on_change               # or always
max_daily_usd: 5
# description: bug-labelled issues become pull requests
# model: anthropic/claude-opus-4      # else the org's tiers
# approvals: inbox                    # inbox (ask, default) | auto | skip, see below
# adapter: claude-code
# budget_usd: 2
# enabled: false
```

`sync` adds new files, updates changed ones in place (what the file says wins; the routine's state stays, so a paused routine stays paused unless the file sets `enabled`), and removes org routines whose file is gone; routines added by hand (`routine add`) and the routines of other orgs are never touched. Run `sync` again after editing the files.

## Editing, drafts and views

`PUT /routines/:id` (`shibaox routine update <id> --on … --input … --model … --approvals …`, or **Edit** on a card) changes the given fields. A routine that came from `org/routines/*.yaml` and is edited this way stops following its file (it becomes `api`): what you changed would otherwise be undone by the next sync.

`GET /routines` answers with views: each routine with `words` (its trigger in words: "Weekdays at 09:00", "On issues labelled bug in acme/app"), `nextRunAt` (the next cron occurrence, a watcher's next look, `null` for paused and manual ones) and `lastRun` (id, status, cost, when).

`POST /routines/draft` (**Create with Shibaox** in the app) turns a sentence ("every weekday at 9 tell me what changed") into a routine draft with the org's cheap tier: name, description, trigger, workflow, instructions and policy, for you to check and save; nothing is saved by the draft itself. Without a callable model it says so (503).

## From the command line and the dashboard

```sh
shibaox routine add chat --on "cron:0 9 * * 1-5" --org ./org --project . --input "What changed since yesterday?" --name "Morning"
shibaox routine add fix-issue --on github:issues --label bug --org ./org --project . --max-daily 5
shibaox routine add chat --on github:checks --branch main --org ./org --project . --input "The CI of main is red: find out why."
shibaox routine list | show <id> | run <id> | pause <id> | resume <id> | rm <id>
shibaox routine sync --org ./org
```

`--on` takes `cron:<expr>`, `github:issues|prs|checks`, `url:<https://…>`, `file:<path>`, `command:<shell command>`; `--every`, `--mode`, `--max-daily`, `--repo`, `--label`, `--branch`, `--adapter`, `--budget` as in the file. `shibaox schedule …` still works: it is the cron subset under its older name, and schedules from earlier versions become cron routines at the daemon's next start.

In the dashboard `/routines` lists them with their trigger and last run: `r` fires the selected one now, `p` pauses or resumes it, enter opens its last run.

A routine's runs carry the origin `routine:<id>`: `shibaox runs`, the audit and the reports show it. A `command` trigger runs the command in the project through a shell as the daemon's user (trusted org config, like a `code` node).
