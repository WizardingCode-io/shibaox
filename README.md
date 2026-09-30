<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/shibaox-lockup-cream.svg">
    <img src="docs/assets/shibaox-lockup-ink.svg" alt="shibaox" width="420">
  </picture>
</p>

<p align="center">
  <strong>An agentic OS for software teams.</strong><br>
  Describe your organisation once, in YAML. Talk to an orchestrator that plans, acts and dispatches teams of agents. Every run is a replayable event log, every risky step waits for you.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/shibaox"><img alt="npm" src="https://img.shields.io/npm/v/shibaox?color=f2842b&label=npm"></a>
  <a href="https://github.com/WizardingCode-io/shibaox/wiki"><img alt="docs" src="https://img.shields.io/badge/docs-wiki-1c140e"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522-1c140e">
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-1c140e">
</p>

---

Shibaox runs on your machine, or on a server you reach with a token. A daemon keeps your runs going after you close the terminal, a terminal dashboard shows what every agent is doing, and your models stay yours: Claude (subscription or API), OpenAI, OpenRouter, Ollama, LM Studio, and thirty more providers through one catalog.

- **Your org, as files.** Teams, roles, gates and workflows in `org/*.yaml`. Version it, review it, share it.
- **One orchestrator.** Ask for what you want in your own language. It reads and edits the project, runs tools, and hands larger work to the right workflow.
- **Gates before anything ships.** The project's own tests, its linter, a model review with a rubric, and a human approval where it matters.
- **A git cycle that lands.** Worktree per run, a commit with a written message, a pull request or a merge through a per-project queue.
- **Nothing off-screen.** Event-sourced runs you can replay, a cost line per turn, approvals in an inbox, reports on Telegram.
- **Watches your repos.** Routines fire on a cron, on labelled issues, on pull requests, on a red CI, on a URL, a file or a command, remember what they found last time, and report back.
- **Runs anywhere.** `shibaox serve` on a VPS or a Mac mini, `shibaox remote set` on your laptop: the same dashboard, the same commands, runs that land while the laptop is closed.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/WizardingCode-io/shibaox/main/scripts/install.sh | sh
```

or, with npm:

```sh
npm i -g shibaox
```

On a server: `docker run -d --name shibaox --init --stop-timeout 75 -p 7433:7433 -e SHIBAOX_DAEMON_TOKEN=… -v shibaox-data:/data -v /srv/projects:/projects ghcr.io/wizardingcode-io/shibaox`, then `shibaox remote set http://<host>:7433 <token>` on your machine.

You need Node 22 or later and git. [Bun](https://bun.sh) 1.3+ runs the dashboard; the CLI and the daemon work without it. Details, upgrades and what the installer changes: [Installation](https://github.com/WizardingCode-io/shibaox/wiki/Installation).

## Sixty seconds

```sh
cd your-project
shibaox keys set OPENROUTER_API_KEY sk-or-...   # or ANTHROPIC_API_KEY, or a Claude login, or Ollama
shibaox doctor                                  # what is ready, what is missing
shibaox                                         # the dashboard
```

Type what you want. The orchestrator answers, acts, and dispatches a team when the work is bigger than a reply. When a run needs you, it says so: `a` approves, `d` denies, `n` adds a note.

From the command line, the same thing:

```sh
shibaox run land-feature --input "Add a /health endpoint with a test"
shibaox inbox                                   # what waits for you
shibaox approve human:<runId>:ship              # the change lands on your base branch
```

## How it works

```
 you ──▶ orchestrator ──▶ workflow: analyse → implement → qa → judge → ship → commit → merge
              │                        │            │          │        │
              │                     agents        gates     decision  human
              ▼                   (any model)  tests·lint·  (typed)   approval
           memory                              review
```

- A **run** executes a workflow as a graph of `task`, `code`, `gate`, `decide`, `human`, `git` and `parallel` nodes. Every step is an event; runs replay, resume after a crash and pause on budget.
- A **task** runs on a runtime adapter: the direct agent loop (any provider), or Claude Code for a Claude subscription. Tools are allowlisted per role; pushes and deploys ask first.
- The **daemon** owns runs, approvals, schedules, channels and the key vault. The **dashboard** and the **CLI** are clients of its socket.

## Learn more

The [wiki](https://github.com/WizardingCode-io/shibaox/wiki) has everything, organised:

| | |
| --- | --- |
| [Quickstart](https://github.com/WizardingCode-io/shibaox/wiki/Quickstart) | first run, first landing |
| [Concepts](https://github.com/WizardingCode-io/shibaox/wiki/Concepts) | orgs, teams, roles, workflows, gates, runs |
| [Dashboard](https://github.com/WizardingCode-io/shibaox/wiki/Dashboard) | keys, slash commands, run tabs |
| [Providers and models](https://github.com/WizardingCode-io/shibaox/wiki/Providers-and-models) | catalog, tiers, keys, costs, local models |
| [Gates](https://github.com/WizardingCode-io/shibaox/wiki/Gates) | tests, lint, review, judge, jev, human |
| [Git cycle](https://github.com/WizardingCode-io/shibaox/wiki/Git-cycle) | commit, pull request, merge queue |
| [Daemon and service](https://github.com/WizardingCode-io/shibaox/wiki/Daemon-and-service) | 24h service, inbox, reports |
| [Routines](https://github.com/WizardingCode-io/shibaox/wiki/Routines) | cron, GitHub issues/PRs/checks, URL, file, command |
| [Remote daemon](https://github.com/WizardingCode-io/shibaox/wiki/Remote-daemon) | `shibaox serve` on a server, a token on your machine |
| [Channels and Telegram](https://github.com/WizardingCode-io/shibaox/wiki/Channels-and-Telegram) | approve and talk from your phone |
| [Security](https://github.com/WizardingCode-io/shibaox/wiki/Security) | what an allowlist is, and is not |
| [CLI reference](https://github.com/WizardingCode-io/shibaox/wiki/CLI-reference) | every command |

## Status

Shibaox is early and moving fast. The base is in place: engine, runtimes, orchestrator, daemon, dashboard, key vault, tiers, real costs, long conversations, git cycle, gates, installer. Teams by stack, other domains and a desktop app come next. Issues and ideas are welcome on the [tracker](https://github.com/WizardingCode-io/shibaox/issues).

Apache-2.0. The Shibaox name, logo and mascot are trademarks of WizardingCode and are not covered by the licence.

Built by [WizardingCode](https://github.com/WizardingCode-io).
