# The app

The dashboard as a web page, on the design system: a sidebar with your conversations, a thread with the agent's messages and every tool call, approvals inline, a composer at the bottom. It runs against a local daemon or a remote one, in any browser, and it is what the desktop app wraps.

## Opening it

```
shibaox app            # opens the browser at the app, connected to this daemon
shibaox app --no-open  # prints the address only
```

Three cases, decided by the CLI:

- **A remote daemon** (`shibaox remote set …` or `--remote`): the daemon serves the app itself at `<url>/app/`; the CLI opens it with the token in the URL fragment.
- **A local daemon with a network listener** (`listen` in `daemon.yaml`, or `shibaox serve`): the same, at `http://127.0.0.1:<port>/app/`, with the token from `SHIBAOX_DAEMON_TOKEN` or the vault.
- **A local daemon on its socket only**: the CLI starts a **bridge**, a loopback HTTP server on a free port that serves the app and forwards its calls to the socket, behind a token made for that session. The address works while `shibaox app` runs (Ctrl-C stops it). Nothing listens off the loopback interface.

The app reads the token off the fragment once, keeps it in the browser's storage, and removes it from the address bar. Opened without a token (the daemon's `/app/` typed by hand), it asks for the token on a **Connect** screen (the daemon is the one that served the page: the API sends no CORS headers, so another origin does not work). A refused token brings that screen back. **Disconnect** in Settings forgets it.

## What is on screen

The sidebar: the Shiba and the wordmark, **New chat**, the sections **Chats · Scheduled · Skills · Memory · Integrations**, the **Recent** conversations, and you (name and Settings). The Chats count is what waits for you; the Scheduled count is the routines that are on.

A conversation: the title (your first request), the agent's status (Working, Needs you, Online, Sleeping, Error), and three tabs.

- **Chat**: your turns and the agent's replies as they stream; each tool call as a card (tool, gist, status, duration, arguments and output on demand); a command or a protected-file write waiting for you as a card with **Approve** and **Deny**; a human node (approve-push and the like) as a message with a note field and the two buttons. While a task runs, **Steer** in the top bar sends it a note (it stops and starts again with it). The composer sends the next turn (Cmd/Ctrl+Enter) once the previous one settled; **Stop** cancels the live turn. The model label is the model of the next turn: **Model** in the top bar picks one for this conversation (in memory until a turn runs on it), Settings sets the one new chats start on.
- **Tasks**: the runs the orchestrator dispatched in this conversation, with status and cost, **Open**, **Steer** (a note for a running one), **Cancel**, and **Resume** with a budget for one that paused on its budget; what a dispatched run asks for (a command approval, a human node) shows on its card and in the chat; a decide node's card says the choice, how sure, and who decided (`jev`, `model:<ref>`, `scripted`). Each reply names the model that wrote it after the time (from the run's usage).
- **Logs**: every node, gate (with each check), decision, approval (who, via which channel) and the run summary; **Open audit** fetches the full audit document with your token and opens it.

**Chats** lists every conversation with its project, last activity, cost and status. In a conversation, **Model** in the top bar picks the model of its next turns from the configured ones (the org's tiers otherwise).

**Scheduled**: the daemon's routines ([Routines](Routines)) as cards: name, description, the trigger in words ("Weekdays at 09:00", "On issues labelled bug"), the next run, the last run (status, cost, when; it opens as a conversation), and badges for Paused, "from the org", a model, and "Auto approvals" or "Skips approvals". Search and sort (next run, name, last run). Each card's menu: **Run now**, **Pause**/**Resume**, **Edit**, **Duplicate**, **Open last run**, **Remove** (asks first). **New routine** offers three ways: **Create with Shibaox** (a sentence becomes a draft for you to check), **Set up manually** (the form), **From a template** (security scan, daily briefing, issue triage, fix labelled bugs, monitor CI, weekly review, dependency updates). The form: name, instructions, project, model, a frequency (manual, hourly, daily, weekdays, weekly, monthly, custom cron, GitHub issues/PRs/checks, a URL, a file, a command, with the result in words), permissions (manually approve, automatically approve, skip all approvals, each with what it means) and advanced settings (workflow, adapter, budget per run, daily cap, how watchers fire, the check interval). Editing a routine that came from `org/routines/*.yaml` detaches it from the file, and the dialog says so.

**Skills**: the org's workflows with their descriptions, each with **Run task** (a request, optionally a project and a model: a run in a worktree, or in place for a conversation workflow, that opens as a conversation), and the catalog's skills, plugins and tools (MCP servers are under Integrations).

**Memory**: the project profile (git branch, stack, package manager, test command, files), the org (adapter, tiers, judge, budget), and where the vault notes live.

**Integrations**: the MCP servers of the catalog with the roles using them and the keys they miss, each with **Test** (starts it on the daemon and lists its tools); every model the daemon knows, configured or missing a key, local servers up or down; the keys of the vault (**Set** a value, never shown again; **Unset**); a **Decisions** block saying who decides for the org (the decision tier: an LLM such as `openrouter/typesafe/jev-router`, or Jev, TypeSafe's typed API, with whether it is usable and why not) and the latest decisions across runs (node, choice, confidence, who decided, each a link into its conversation; a chat makes none, decide nodes and judged gates do); the org's tiers, judge and budget per run (**Save tiers**).

**Settings**: theme (light, dark, system), your name, the project, org and model new chats use, the daemon's address and version, Disconnect.

**Replies as documents.** The agent's text renders as Markdown: headings, lists, task lists, quotes, tables, links (they open in a new tab; only web and mail links are links), and fenced code with the brand's syntax colours (Copy on every block, long blocks clipped with "Show all"). An unlabelled block that is plainly CSV shows as a table. Tool calls and files appear where they happened in the reply, not after it. Your own messages keep their line breaks and show inline marks only.

**Files a run produced.** A file the run wrote shows as a chip in the reply and in the "Outputs" row under the top bar. A chip opens the file in a panel on the right: CSV as a table, Markdown as a document, code with colours, images inline, anything else says there is no preview; Copy and Download (or, on the desktop, Open and Save as…) are in the panel's head and always carry the whole file, while the view stops at 2 MB. The panel reads the file from the run's workspace through the daemon, so it works for remote daemons too; `.env`, `.git` and the project's protected files are never shown. The same files from the terminal: `shibaox files <runId> [path]`.

**Code that becomes a file.** The panel previews what it can: CSV and TSV as a table even when the rows are uneven, JSON pretty-printed, Markdown rendered, code with colours, text, images; anything else says there is no preview and still offers the actions. Every code block and CSV table in a reply has **Open**: the block opens in the same panel as a file (named from the fence, a `file:` comment, its first function, or its kind: `fibonacci.js`, `table.csv`), with Copy and Download, and, when the conversation has a finished run with a workspace, **Save to project**: a path inside that workspace, written through the daemon (`PUT /runs/:id/files/content`), listed under Outputs and in `shibaox files` as a file of yours. The orchestrator is also told to create requested files with its own tools; Open is for the times it only shows the code.

When a dispatched run ends while its conversation is open, the app tells the orchestrator (an event turn), as the terminal dashboard does; the orchestrator may then answer or dispatch more.

## The desktop app (macOS)

`Shibaox.app` is the same app in its own window, without a browser or a terminal. It is a dmg for Apple silicon and Intel, attached to each [release](https://github.com/WizardingCode-io/shibaox/releases) (`Shibaox-<version>-arm64.dmg`, `Shibaox-<version>-x64.dmg`). Releases built with the Apple secrets in place are signed with a Developer ID and notarized, and open like any app. A build without them is signed ad hoc: the first launch is refused, then allowed once under System Settings, Privacy and Security, "Open Anyway" (or `xattr -dr com.apple.quarantine /Applications/Shibaox.app`).

On the desktop the panel's **Open** hands the file to the app that reads it (Excel or Numbers for a CSV, your editor for code, the browser for HTML; kinds that would run rather than open are refused), **Save as…** is the macOS save dialog, and a file saved to the project gets **Reveal in Finder**. In a browser the same place offers Download.

The app keeps itself current: it checks the [releases](https://github.com/WizardingCode-io/shibaox/releases) shortly after it starts and every few hours, downloads a newer version in the background and asks once per launch, "Restart now" or "Later" (later, it installs when you quit). **Shibaox → Check for Updates…** checks on the spot. What it did is in `~/.shibaox/desktop.log`. The browser app inside it updates with it; the daemon is updated separately (`shibaox upgrade`, see [CLI reference](CLI-reference)).

It needs the CLI installed (`npm i -g shibaox`): on launch it talks to the local daemon through its own bridge on a loopback port (7434 or the next free one) and starts the daemon when it is not running (the launchd service when `shibaox daemon install` set one up, else the installer's launcher, else `shibaox daemon start --detach` through your login shell; the daemon logs to `~/.shibaox/daemon.log`). With `shibaox remote set <url> <token>` done, it opens that remote daemon's app instead. When no daemon can be reached, it says why and offers "Try again".

Links out of the app (a PR, the wiki) open in your browser. The window has no Node access; the bridge's token is random per launch and never leaves the machine.

## Themes and the design system

Light ("warm paper") and dark ("night") follow the system by default. Everything on screen is a component of the Shibaox design system (tokens, Geist and Bricolage Grotesque, the mascot), vendored into the app package at build time (`scripts/sync-design-system.sh`).

## Security

- The app itself (HTML, scripts, styles) is public on the daemon's listeners: it holds nothing. Every call it makes carries the bearer token, and a token is shell access on the daemon's machine: the address `shibaox app` prints contains it, so treat that address as you treat the token (do not paste it in chats; the fragment never reaches a server, but it sits in the browser's history until the app strips it and in the browser's storage until Disconnect).
- The bridge's token is random per session and dies with the command. The address (token included) is passed to the system's opener (`open`, `xdg-open`, `start`), so it is visible in the process list for a moment.
- The app never renders model output as HTML: text is text.

## Troubleshooting

- `The daemon listens on the network but its token is not here`: run `shibaox app` where the token is (`SHIBAOX_DAEMON_TOKEN`, or `shibaox keys set SHIBAOX_DAEMON_TOKEN …` on the daemon's machine), or open `http://<host>:<port>/app/` and paste the token on the Connect screen.
- `the browser app is not installed next to this daemon`: `npm i -g shibaox@latest` (the app ships with it, as `@wizardingcode/shibaox-app`); a daemon started from a development checkout needs `pnpm build`.
- A blank page: the daemon must be 0.2.1 or later (`shibaox daemon stop` restarts it on the new build).
- The desktop app says `shibaox is not in the PATH`: your login shell (`.zprofile`, `.zshrc`) does not find `shibaox` (`npm i -g shibaox`, or start the daemon in a terminal and press Try again). `exited with …`: the daemon refused to start, `~/.shibaox/daemon.log` says why.
