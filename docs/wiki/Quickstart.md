# Quickstart

Ten minutes from a fresh install to a change landed on your branch.

## 1. A model

Shibaox needs one model it can call. Pick whichever you have:

```sh
shibaox keys set OPENROUTER_API_KEY sk-or-...    # any model on OpenRouter
shibaox keys set ANTHROPIC_API_KEY sk-ant-...    # Anthropic API
# a Claude subscription: sign in with the `claude` CLI, nothing else to set
# local: ollama pull qwen2.5-coder:7b, or a model loaded in LM Studio
shibaox doctor
```

Keys live in Shibaox's own vault (`~/.shibaox/secrets.json`), shared by the daemon, the CLI and the dashboard. See [Providers and models](Providers-and-models).

## 2. An org

The first time the daemon starts it creates a default org in `~/.shibaox/org`: an `engineering` team with `team-leader`, `analyst` and `backend` roles, an `assistant` role for conversations, the gates `tests`, `lint` and `review`, and the workflows `chat`, `hello-feature` and `land-feature`. Its tiers point at what your keys allow (a Claude subscription when `claude` is installed, else OpenRouter, else the template).

A project can carry its own org instead: `shibaox init .` scaffolds `org/` and `vault/` next to it, and the dashboard uses `./org` when it exists. `shibaox init . --stack auto` reads the stack off the manifest (`package.json`, `pyproject.toml`/`requirements.txt`, `composer.json` + `artisan`, `go.mod`) and adds what a team of that stack needs on day one: a `shibaox.yaml` with protected files (the detected setup, test, lint and type-check commands are left as comments: they are detected on every run), a `typecheck` gate on every workflow (the checker is found at run time; none passes with a note), a `review` gate with the stack's checklist, a weekly `security-scan` (npm audit / pip-audit / composer audit / govulncheck) as a workflow and a routine file, and for Node a `frontend` role. See [Concepts](Concepts) and [Configuration](Configuration).

## 3. Talk

```sh
cd your-project
shibaox
```

Type what you want and press enter. The orchestrator answers in your language, reads and edits the project, runs the programs its role allows, and dispatches a workflow when the work is bigger than a reply. Under the prompt: the model, how full its context is, the git branch, the cost of the thread.

Useful slash commands: `/model` (pick a model for the run), `/tiers` (the org's tiers), `/keys`, `/workflow`, `/runs`, `/help`. See [Dashboard](Dashboard).

## 4. Land a change

`land-feature` analyses, implements, runs the project's tests, asks a decision model whether it is ready, waits for your approval, commits and lands on the base branch (pushed when there is an `origin`):

```sh
shibaox run land-feature --input "Add greet.js with greet(name) and a test" --detach
shibaox inbox
shibaox approve human:<runId>:ship
git log --oneline -3
```

In a git repository the run works in its own worktree and branch, so your checkout is never touched until the merge. See [Git cycle](Git-cycle) and [Worktrees](Worktrees).

## 5. Keep it running

```sh
shibaox daemon install     # macOS: starts at login, restarts if it exits
shibaox schedule add "0 9 * * 1-5" hello-feature --input "daily check"
```

Set a Telegram bot and you can approve and talk from your phone. See [Daemon and service](Daemon-and-service) and [Channels and Telegram](Channels-and-Telegram).
