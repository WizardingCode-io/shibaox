<p align="center">
  <img src="https://raw.githubusercontent.com/WizardingCode-io/shibaox/main/docs/assets/shibaox-mark.svg" alt="" width="96">
</p>

# Shibaox

An agentic OS for software teams. You describe your organisation in YAML, talk to an orchestrator, and it plans, acts and dispatches teams of agents on your projects. Every run is a replayable event log, every risky step waits for you.

## Start here

- [Installation](Installation) — one command, what it changes, upgrades
- [Quickstart](Quickstart) — first conversation, first landed change
- [Concepts](Concepts) — orgs, teams, roles, workflows, gates, runs, nodes

## Using Shibaox

- [Dashboard](Dashboard) — the terminal UI: home, run tabs, slash commands, keys
- [Orchestrator](Orchestrator) — how it acts, dispatches and remembers; long conversations
- [Providers and models](Providers-and-models) — catalog, keys vault, tiers, `/model`, costs, local models
- [Gates](Gates) — tests, lint, review, judge, jev, human
- [Git cycle](Git-cycle) — commit, pull request, merge queue
- [GitHub loop](GitHub-loop) — `run --issue`, the `ci` check, reviews and merges through `gh`, reports on the issue
- [Daemon and service](Daemon-and-service) — 24h service, inbox, schedules, reports
- [Remote daemon](Remote-daemon) — `shibaox serve` on a server, `shibaox remote set` on your machine
- [Routines](Routines) — cron, GitHub issues/PRs/checks, a URL, a file, a command: what the daemon does on its own
- [Channels and Telegram](Channels-and-Telegram) — approvals and conversations from your phone
- [Claude Code runtime](Claude-Code-runtime) — the subscription path and its tool rules
- [Worktrees](Worktrees) — where tasks work
- [Memory](Memory) — vault notes, remember/recall, graphify

## Reference

- [Configuration](Configuration) — `org.yaml`, `models.yaml`, roles, workflows, gates, `daemon.yaml`
- [CLI reference](CLI-reference) — every command and flag
- [Security](Security) — allowlists, approvals, what is not a sandbox
- [Troubleshooting](Troubleshooting) — doctor, Node upgrades, native modules, Bun
- [Development](Development) — the monorepo, tests, releasing

## Where things are

| | |
| --- | --- |
| Repository | https://github.com/WizardingCode-io/shibaox |
| npm | `shibaox` (CLI) and `@wizardingcode/shibaox-*` (packages) |
| Your data | `~/.shibaox/` — runs, keys vault, default org, daemon socket |
