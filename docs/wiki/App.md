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

The sidebar: the Shiba and the wordmark, **New chat**, the sections **Chats · Scheduled · Skills · Memory · Integrations** (the last four arrive in the next releases; until then the CLI covers them), the **Recent** conversations, and you (name and Settings).

A conversation: the title (your first request), the agent's status (Working, Needs you, Online, Sleeping, Error), and three tabs.

- **Chat**: your turns and the agent's replies as they stream; each tool call as a card (tool, gist, status, duration, arguments and output on demand); a command or a protected-file write waiting for you as a card with **Approve** and **Deny**; a human node (approve-push and the like) as a message with a note field and the two buttons. While a task runs, **Steer** in the top bar sends it a note (it stops and starts again with it). The composer sends the next turn (Cmd/Ctrl+Enter) once the previous one settled; **Stop** cancels the live turn. The model label is the run's model (choosing another one per conversation comes in the next release; Settings sets the model new chats start on).
- **Tasks**: the runs the orchestrator dispatched in this conversation, with status and cost, **Open**, **Steer** (a note for a running one), **Cancel**, and **Resume** with a budget for one that paused on its budget; what a dispatched run asks for (a command approval, a human node) shows on its card and in the chat.
- **Logs**: every node, gate (with each check), decision, approval (who, via which channel) and the run summary; **Open audit** fetches the full audit document with your token and opens it.

**Chats** lists every conversation with its project, last activity, cost and status. **Settings**: theme (light, dark, system), your name, the project, org and model new chats use, the daemon's address and version, Disconnect.

When a dispatched run ends while its conversation is open, the app tells the orchestrator (an event turn), as the terminal dashboard does; the orchestrator may then answer or dispatch more.

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
