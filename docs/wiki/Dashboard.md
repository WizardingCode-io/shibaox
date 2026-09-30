# Dashboard

`shibaox` with no command (or `shibaox ui`) opens the dashboard over the daemon. It is an OpenTUI + Solid app that runs under Bun 1.3 or later (the CLI checks and spawns it). Without Bun the CLI says so and the text commands keep working. It needs an interactive terminal of at least 60×15.

## Home

The logo and a prompt: type what you want and press enter. The org's `chat` workflow (the default) talks to the [orchestrator](Orchestrator); any other workflow starts a team run. Under the prompt, one line says what the project is (`Next.js · React · TypeScript · pnpm test · 412 files`).

Slash commands set the context shown inside the prompt:

| Command | |
| --- | --- |
| `/model` | pin a `provider/model` for the run: the whole catalog, configured models first, OpenRouter's full list with a key, what LM Studio and Ollama have running; price per million tokens and context window in the hint. The adapter follows from the model. Remembered. `default` goes back to the org's routing. |
| `/tiers` | the org's `strong`, `cheap`, `decision`, `judge` and `adapter`: enter opens the model list, enter saves, `x` clears judge/adapter. The next run uses the new tiers. |
| `/keys`, `/key NAME value` | the key vault: what is set and where from; set one, masked. |
| `/workflow`, `/adapter`, `/workspace` | pick from a list (`enter` takes the highlighted value) |
| `/project <dir>`, `/org <dir>`, `/budget <usd>` | take a value |
| `/runs`, `/help` | dialogs |

The org defaults to `./org` next to the project when it exists, else the daemon's default org; the project to the current directory (your home directory itself becomes `~/.shibaox/workspace`). The last org, adapter, workflow and model are remembered in `~/.shibaox/ui.json`. The footer shows the daemon, how many runs work or wait, and how many things need you.

With a [remote daemon](Remote-daemon) the dashboard reads nothing from your disk: the project is the first the daemon offers (`daemon.yaml projects`, recent runs, its workspace), the org is the daemon's default, `/project` and `/org` take absolute paths on that machine and the daemon checks them, and the footer names the remote.

## A run

A run opens as a tab and reads like a conversation: one card per node with the agent's text in Markdown, tool calls (`> Read src/a.ts · 7 ms · done`; `enter` shows input and output), touched files, gate checks with evidence, the decision and its confidence, and a summary at the end (status, cost, duration, files changed, branch).

While the run waits for you, the bottom asks: `a` approves, `d` denies, `n` adds a note (a command approval asks `y` first). While a task runs, `s` steers it: type a note and the task stops and starts again with it (a Claude Code session is resumed with the note; the direct agent loop gets it in its prompt). Tabs pulse when their run ends or starts waiting.

When a run ends, the prompt comes back at the bottom of its tab: the next request runs in the same tab and the conversation so far travels with it. A chat turn reads as a message; a run the orchestrator dispatched shows under `→ <workflow>` with its own cards, approvals and diff, and when it ends a quiet `↳ workflow … finished` line hands the outcome back to the orchestrator, which replies.

In a run tab `/` offers the screen's commands (`/diff`, `/cancel`, `/resume`, `/sidebar`, `/home`, `/runs`, `/help`, `/close`, `/quit`, and `/model` for the next turns). Under the status while it works, and under the prompt once done, one line says where you are: context use (`12% ctx`, or `24.0k tokens` when the window is unknown), the model, the branch (`⎇ main`), the project, the org, the workflow, the thread's cost and the time.

The sidebar (automatic from 120 columns, `ctrl+b`) shows the request, cost and progress, the nodes as a checklist, the files touched and what needs you; drag its edge to resize.

## Keys

`ctrl+n` home · `ctrl+o` open a run · `ctrl+k` command palette · `ctrl+]` / `ctrl+p` next and previous tab · `ctrl+w` close tab · `ctrl+b` sidebar · `?` help · `ctrl+q` quit (the daemon keeps running).

In a run: `j`/`k` move the cursor, `↑`/`↓` or the wheel scroll, `enter` expand, `g`/`G` top and follow, `d` diff of the run's checkout, `c` cancel, `s` steer the running task, `r` resume, `tab` sidebar.

`SHIBAOX_NO_MOTION=1` (or `"animations": false` in `ui.json`) turns every animation off.

## The same view from the CLI

In an interactive terminal with Bun, `shibaox run` (without `--detach`) and `shibaox follow` show the run view; without a TTY, without Bun, or with `--json`, they print plain lines. `q` leaves a run going in the daemon.
