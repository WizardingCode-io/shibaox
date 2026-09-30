# MCP servers and skills

A role can list **MCP servers** and **skills**. The servers give it tools in every runtime (the direct adapter on any model, and Claude Code); the skills are instructions appended to its prompt. Both live in the org, versioned with the rest.

## An MCP server in the catalog

`org/catalog/<id>.yaml` with `type: mcp` and a `server:` block:

```yaml
id: playwright
type: mcp
description: "A browser (Playwright MCP): open pages, click, fill forms, read the page, screenshots."
tags: [browser, e2e]
server:
  transport: stdio                     # stdio | http
  command: npx                         # stdio: the executable (on PATH)
  args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--isolated']   # pinned; one profile per task
  env: { PWDEBUG: '0' }                # fixed environment (never secrets)
  env_keys: []                         # vault keys the server needs (see below)
  tools: []                            # allowlist; empty or absent = every tool
  timeout_ms: 30000                    # start/connect and per-call timeout
```

An http server: `transport: http`, `url: https://…/mcp`, optional `headers` (a `${KEY}` inside a header value is expanded from `env_keys`).

`env_keys` are read from the daemon's environment with the vault on top: `shibaox keys set DOCS_TOKEN …` and the server gets `DOCS_TOKEN`. A missing key fails the task at its start with the key's name, and `shibaox mcp list` shows it as missing. The values never appear in a command line: the direct adapter passes them to the process environment; Claude Code receives the server config with `${DOCS_TOKEN}` placeholders and the values in its own environment (they never sit on the Claude Code CLI's argv). Any daemon env var can be named, so keep to keys made for the server: a provider key named here would reach that server. `shibaox init` ships `catalog/playwright.yaml` (version pinned, `--isolated` so parallel tasks never share a browser profile); nothing uses it until a role lists it.

An `mcp` entry **without** `server:` is a built-in capability marker (the `graphify-mcp` entry autorouting may attach, see [Memory](Memory)); it cannot be listed under a role's `mcp:`.

## Giving a role the tools

```yaml
role: qa
tools: [read, node]
mcp: [playwright]          # every tool of the server, as mcp__playwright__<tool>
skills: [e2e-checklist]    # org/skills/e2e-checklist/SKILL.md, appended to the prompt
```

`loadOrg` refuses a role naming a catalog entry that does not exist, is not an `mcp` entry, or has no server, and a skill without its `SKILL.md`.

**Direct adapter.** The servers start when the task starts (in parallel, stdio servers in the task's workspace as their working directory), their tools are offered as `mcp__<id>__<tool>` with the server's own JSON Schema, every call shows in the run as a tool card (input, result, duration), and the servers stop when the task ends, also on a cancel or a steer. A server that does not start within `timeout_ms` (or exits) fails the task: `mcp server "playwright" failed to start: …`. A tool result flagged as an error reaches the model as `{error}`; a result longer than 100 000 characters is cut with a `…[truncated N characters]` note (a page snapshot can be large); images and other non-text content are not passed to the model (a screenshot tool's image is dropped, its text kept). Tool names are made safe for the model (`search.pages` → `mcp__docs__search_pages`, at most 64 characters), the same in both runtimes; an mcp id may not contain `:` or `__`, and `shibaox`/`graphify` are reserved.

**Claude Code.** The same entries are passed as Claude Code MCP servers (stdio or http) and allowed as `mcp__<id>__*`, or only the allowlisted names. Claude Code starts and stops them itself; a listed server that Claude Code reports as failed (or needing auth) fails the task, as on the direct adapter. Their stderr is handled by Claude Code, not written to the daemon log.

**Approvals.** MCP tool calls are **not** gated by the approval categories (push, deploy…): Shibaox cannot know what a server's tool does. Listing a server on a role is the decision to trust its tools with that role's tasks. A browser goes wherever the model decides: keep `playwright` on roles whose tasks you would let browse, and prefer `tools:` allowlists for servers that can act (send, delete, pay).

## Skills

`org/skills/<id>/SKILL.md`, Markdown, optional YAML frontmatter (dropped from the prompt). Each skill of a role goes into the system prompt as `## Skill: <id>` followed by the file's body, in both runtimes. Keep them short and imperative; they are read on every task of the role. Files next to `SKILL.md` are not sent (the skill may tell the model to read them from the workspace when the org is checked out there).

## Checking what is wired

```
shibaox mcp list [--org dir]      # every catalog server: transport, target, roles using it, keys set or missing
shibaox mcp test <id> [--org dir] # starts it on the daemon, lists its tools, stops it
```

`mcp test` runs on the daemon, with the daemon's environment and vault; the exit code is 1 when the server does not start. Over the network (a [remote daemon](Remote-daemon)) it starts servers of the daemon's own org (`~/.shibaox/org`) or of a project listed in `daemon.yaml` only: starting a command defined in an arbitrary org path is done from the daemon's machine (403 otherwise); `mcp list` works for any org. The API: `GET /mcp?org=` and `POST /mcp/:id/test?org=`. The check takes up to `timeout_ms` to connect and as much again to list.

## Troubleshooting

- `needs DOCS_TOKEN in the vault`: `shibaox keys set DOCS_TOKEN …` on the machine that runs the daemon.
- `failed to start: Connection closed`: the command exited at once; run it by hand (`npx -y @playwright/mcp@0.0.83 --help`) with the daemon's PATH in mind (a launchd/systemd daemon has a smaller PATH than your shell: put the tool under `/usr/local/bin` or give an absolute `command`).
- Playwright on Linux or in Docker: the default browser channel is Chrome; without it add `--browser chromium` to the args and run `npx playwright install chromium` as the daemon user once.
- `did not answer in time`: raise `timeout_ms`; the first `npx -y` run downloads the package.
- On the direct adapter a server's stderr goes to the daemon log, prefixed `[mcp <id>]`.
