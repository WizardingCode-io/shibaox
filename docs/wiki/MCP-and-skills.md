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

## Adding a connector from the app or CLI

The app's **Customize → Connectors** (and the CLI) write the catalog file and the role lists for you, keeping the comments of files that exist:

```
shibaox mcp add github --url https://api.githubcopilot.com/mcp/ \
  --header 'Authorization=Bearer ${GH_TOKEN}' --role assistant --description "GitHub"
shibaox mcp add fetch --command uvx --arg mcp-server-fetch --tool fetch --role backend
shibaox mcp rm github           # taken off every role first, then catalog/github.yaml is deleted
shibaox roles list              # each role's model, mcp and skills
```

`mcp add` takes `--url` (http) or `--command` (stdio) with `--arg` (repeat it; a value starting with `-` takes the `=` form, `--arg=-y`), `--key NAME` (a vault key the server needs), `--header NAME=VALUE`, `--bearer-command <arg>` (one argument per flag, repeat it like `--arg`; never a shell), `--tool`, `--role`, `--description`, `--timeout <ms>`, and `--replace` to overwrite an entry with the same id (refused otherwise: "exists (use --replace)"; an id held by an entry that is not an mcp server, or a `catalog/<id>.yaml` holding another id, says "pick another id"). A `${KEY}` in a header is added to `env_keys` by itself; a literal secret in a credential header (a name with `auth`, `token` or `key`) is refused: put it in the vault (`shibaox keys set NAME`) and write `${NAME}`. The roles named must exist; the final entry is checked against the catalog schema before anything is written.

The API behind both: `GET /mcp?org=` → rows with `id`, `description`, `transport`, `target`, `tools?`, `roles`, `keys` (from `env_keys` and every `${KEY}` of a header, each with `present`) and `server` (the block as loaded, placeholders kept); `POST /mcp?org=` with `{id, description, tags?, server, roles?, replace?}` (409 `exists` when the id exists and `replace` is not set, `not_mcp` for an entry of another type, `catalog_file_collision` when `catalog/<id>.yaml` holds another id; 400 `secret_in_header`; replacing edits the file that holds the id, whatever its name; with `replace` and `roles`, the roles that list the server become exactly `roles`, without `roles` they stay as they are); `DELETE /mcp/:id?org=` (404 for an entry that is not an mcp server); `GET /roles?org=` and `PUT /roles/:id?org=` with `{mcp?, skills?}` (the lists are replaced; an unknown server, an entry that is not an `mcp` server with a `server:` block, a reserved id or a skill without its `SKILL.md` is a 400 naming it). Every id is checked before a file is written.

### The registry

`GET /registry/connectors` is a built-in list of ready entries the app's **Discover** shows, each with its vendor, a `verified` flag (run by the vendor), a category (Code, Browser, Data, Docs, Design & media, Productivity, Infra, Search), the keys it needs with where to get them, and the `server` block to add: Higgsfield, Playwright (both the scaffold's own files), GitHub, Context7, Fetch, Filesystem, Memory, Sequential thinking, Notion, Linear, Sentry, Stripe, Supabase, Cloudflare docs, Firecrawl, Exa, Brave Search (`@brave/brave-search-mcp-server`), Figma and Vercel. The http servers that use OAuth (Notion, Linear, Sentry, Supabase, Figma, Vercel) have no key: they sign in with OAuth through the Claude Code runtime; the direct runtime cannot sign in yet. Exa works without a key at lower limits; to use yours, put `?exaApiKey=…` in the URL when adding. Filesystem's last argument is the placeholder `/path/to/allow`: replace it with the directories it may touch. `GET /registry/skills` lists the skill repositories offered (`anthropics/skills`, `higgsfield-ai/skills`); their contents come from `/skills/discover`.

## Skills from a repository

```
shibaox skills list                              # every skill, and the roles that use it
shibaox skills add anthropics/skills/skills      # owner/repo[/path]: every folder with a SKILL.md
shibaox skills add github.com/anthropics/skills --path skills --id pdf --id docx
shibaox skills add ~/my-skills                   # a folder on this machine (starts with . / or ~)
shibaox skills add --folder my-skills            # a relative folder without ./ in front
shibaox skills rm pdf [--detach]                 # refused while a role uses it, unless --detach
```

The daemon clones the repository (`git clone --depth 1 --single-branch --no-recurse-submodules --no-checkout`, no shell, a minimal environment, no user or system git config, one clone at a time, 60 s) into a temporary directory that is always removed, lists the tree of the path and refuses it (413) over 50 MB or 20 000 files before checking anything out, checks out that path only, finds every directory holding a `SKILL.md` under it, and copies each as `org/skills/<directory name>/`. The id must be a valid org id (letters, digits, `-`, `_`, `:`); an id that exists already is skipped (`exists`), never overwritten. Only regular files are copied: a file over 1 MB is left out and listed in the skill's `omitted`, a skill over 10 MB is skipped (`too_large`); symlinks are never followed or copied (a `SKILL.md` that is one: `symlink`), and nothing outside the skill's directory is read. A copy that fails skips that skill only (`copy_failed`). A new skill is not used until a role lists it (`skills: [id]`, or **Roles…** in the app).

The API: `GET /skills?org=` → `{id, name, description, path, roles}[]` (name and description from the frontmatter, else the id and the first paragraph); `GET /skills/:id?org=` → the same row plus `content` (the `SKILL.md` text, at most 1 MB; 404 for an unknown id); `POST /skills?org=` with `{source: 'repo', repo, path?, ids?}`, `{source: 'folder', path}` or `{source: 'inline', id, content}` → `{added: (row & {omitted?})[], skipped: {id, reason}[]}`; `GET /skills/discover?repo=&path=` lists a repository's skills without installing (cached for 10 minutes per repository and path, a failure for 30 s, 50 entries at most; the same discovery in flight is shared); `DELETE /skills/:id?org=&detach=1` (409 with `roles` when used and not detaching). Writes are for callers on the daemon's machine only ([Security](Security)).

## Plugins

`shibaox plugins` (`GET /plugins`) shows the integrations that need more than one server: Higgsfield (the CLI, the login, the MCP), GitHub (`gh` and a token), Telegram (the bot token) and TypeSafe / Jev (the key and whether Jev decides). Each is `ready` when every check passes, `partial` when some do, `off` when none.

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

`server.bearer_command` (http servers): a command whose stdout is the bearer token, run before each connection with a minimal environment; a CLI's login stands in for a key (Higgsfield: `[higgsfield, auth, token]`). A failing command skips the server for that task with a note. See [Security](Security).
