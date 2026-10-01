# Customize: skills, connectors, plugins, keys, models — one organised screen

Date: 2026-10-01. Status: approved by Andre ("isto tem que ser mesmo muito bem organizado…
uma tab para definirmos as keys que temos disponíveis e as que vão ser necessárias para os
plugins, de forma organizada"). Reference: the Customize screen of Claude.ai (Skills ·
Connectors · Plugins, Yours/Discover, search, category filter, "+ Add" with "Add marketplace",
"Upload plugin", "Add custom connector" with name + MCP URL).

## Goal

Replace the **Skills** and **Integrations** sections of the app with one **Customize** screen
where everything that extends Shibaox is found, added, wired to roles and given its keys, in
the same shapes a user already knows from Claude.ai. The org files stay the source of truth
(`org/catalog/*.yaml`, `org/skills/<id>/SKILL.md`, `org/roles/*.yaml`, `~/.shibaox/secrets.json`);
the screen edits them through the daemon.

## Screen

Route `#/customize` with `&tab=skills|connectors|plugins|keys|models` (default `skills`) and
`&view=yours|discover` where it applies. `#/skills` and `#/integrations` redirect (old links,
sidebar entries removed). Sidebar: Chats · Scheduled · Customize (icon `puzzle`) · Memory.

Header (all tabs): `h1 Customize` · Tabs (Skills, Connectors, Plugins, Keys, Models) · for
Skills/Connectors/Plugins a **segmented Yours | Discover** control (Yours shows a dot when
something needs attention: a missing key, a server whose test failed, a skill no role uses) ·
search `Input icon=search` (filters the visible list by name/description/id/key) · a category
`Menu` (checked item) · `+ Add` button with a `Menu`.

Cards are the DS `Card` in a 2-column grid (`.grid-2`, 1 column under 900 px) with: icon,
title, description (2 lines, ellipsis), meta line (`by …`, roles, keys), and an action on
the right: `+` to add (Discover), `✓` when already yours, or a `…` menu (Yours).

### Skills tab

- **Yours**: every `org/skills/<id>/SKILL.md` as a card (title = frontmatter `name` or id,
  description = frontmatter `description` or the first paragraph), meta: `Used by: assistant,
  reviewer` or `Not used by any role` (warning badge). Menu: **Open** (Sheet with the Markdown
  rendered + path + Copy), **Roles…** (Dialog with a checkbox per role → `PUT /roles/:id`),
  **Remove** (Dialog confirm; refused while a role uses it unless "detach from roles" is ticked).
- Workflows (today's Skills screen) stay here below the skills, as the section **Workflows**
  with the same "Run task" form (unchanged behaviour).
- **Discover**: cards from the built-in skill sources (see Registries) grouped by source with a
  category filter; `+` installs the skill (clone depth 1, copy the folder) and opens the Roles
  dialog right away. Search also filters the source listing.
- **+ Add** menu: **From a repository** (Dialog: GitHub `owner/repo[/path]` or git URL, lists
  what it finds, pick which to install), **From a folder** (Dialog with the local path; the
  daemon copies it; local daemon only), **Write a skill** (Dialog: id + Textarea with a
  SKILL.md template; saved as `org/skills/<id>/SKILL.md`).

### Connectors tab (MCP servers)

- **Yours**: catalog entries `type: mcp` with `server`. Card: icon `plug`, title (id),
  description, meta: transport + target (mono, ellipsis), `Roles: …`, keys as small badges
  (`matcha` present, `warning` missing → click goes to Keys with the key focused). Action:
  **Test** (inline result: n tools or the error) and a `…` menu: **Roles…**, **Edit…** (same
  Dialog as Add custom, pre-filled), **Remove** (detaches from roles first, confirm).
- **Discover**: the built-in connector registry (see Registries) as cards with category
  filter (`Code`, `Browser`, `Data`, `Docs`, `Design & media`, `Productivity`, `Infra`,
  `Search`), `by <vendor>`, `verified` badge for official servers. `+` opens a short Dialog
  "Add <name>": the keys it needs (inline set when missing, with the signup link), the roles
  to attach (checkboxes, `assistant` checked by default), **Add**. Already-added ones show `✓`.
- **+ Add** menu: **Custom connector** (Dialog: Name/id, transport `http`|`stdio`, URL or
  command + args, keys needed (names), headers (http), bearer command (http), tools allowlist,
  timeout, roles) → `POST /mcp`; **From the registry** jumps to Discover.

### Plugins tab (partner integrations with their own setup)

A plugin is something larger than one MCP server: it has a CLI or an account, a login, keys,
and it brings connectors and skills. This tab is the home of what was spread over
Integrations: cards for **Higgsfield** (CLI installed/version, logged in + account/credits,
MCP ok/unauthorized/unreachable; actions Install command (copy), Log in, Create account
(affiliate), Open; "brings: connector `higgsfield`, skill `higgsfield`" with add buttons),
**GitHub** (`gh` present + `GH_TOKEN`/`GITHUB_TOKEN`; brings the github loop), **Telegram**
(`SHIBAOX_TELEGRAM_TOKEN`; link to the channel docs), **TypeSafe / Jev** (`TYPESAFE_API_KEY`,
decider status from `/decisions`). Status comes from `GET /plugins`. Yours/Discover applies:
Yours = plugins with something configured; Discover = the rest. No "+ Add" here (plugins
are built in; the menu says so and links to the connector/skill paths).

### Keys tab

The organised vault. Three blocks, each a table (`Table dense`) with search:

1. **Needed now** — keys referenced by: the tiers' models (strong/cheap/decision/judge), the
   models of the org's roles (`roles[].model` when set), the connectors of the catalog
   (`env_keys` + `${KEY}` in headers), the plugins. Columns: Key · Needed by (badges:
   `tier strong`, `connector github`, `plugin telegram`) · Status (`set · sk-…7890 · vault|env`
   or `missing`) · Action (Set with a password input + Save, or Unset). Missing rows first.
2. **Providers** — one row per provider from the provider catalog (ANTHROPIC, OPENAI, …):
   Provider · Key name · Status · models that would unlock (count, hover list) · Action. Rows
   with a set key first; a "Show all providers" toggle (default: set ones + the needed ones).
3. **Other** — built-in (Telegram, GitHub, daemon token, TypeSafe) and custom keys; **Add key**
   (name validated `^[A-Z][A-Z0-9_]*$` + value).

Masked values never leave the daemon unmasked; the env-sourced keys cannot be unset here
(say "from the environment"). `?key=NAME` in the route focuses that row (used by the missing
badges elsewhere).

### Models tab

What Integrations showed, organised: **Tiers** (the existing form) on top; then the model
table with search and a filter (All · Ready · Missing key · Missing runtime · Local), columns
Model (ref mono) · Provider · Status badge (click → Keys) · Context · Price; then
**Decisions** (the existing card) at the bottom.

## Daemon API (new or changed)

All under the existing bearer. Writes that touch the org directory are refused over a
network listener unless the caller is loopback (same rule as `/integrations/higgsfield/login`),
and always refused for a remote daemon page without the token. Every write validates with the
schemas first and keeps YAML comments where the file exists (same helper as org-config).

- `GET /skills?org=` → `SkillRow[]`: `{id, name, description, path, roles: string[]}`.
- `POST /skills?org=` body one of:
  `{source:'repo', repo:'owner/repo' | 'https://…git', path?: string, ids?: string[]}`,
  `{source:'folder', path: string}` (local only),
  `{source:'inline', id, content}` →
  `{added: SkillRow[], skipped: {id, reason}[]}`. Repo: `git clone --depth 1` into a temp dir
  (60 s timeout, 50 MB cap, no submodules), find every directory with a `SKILL.md` under
  `path` (or the whole repo), id = directory name (validated by `IdSchema`), refuse ids that
  already exist (skipped `exists`), copy only regular files ≤ 1 MB each and ≤ 10 MB per skill,
  never symlinks. `ids` limits what is installed.
- `GET /skills/discover?repo=owner/repo[&path=]` → `{repo, skills: {id, name, description,
  path}[]}` from a cached clone (per daemon process, 10 min) — used by Discover and by the
  "From a repository" dialog.
- `DELETE /skills/:id?org=&detach=1` → `{removed:true}`; 409 `{roles:[…]}` when used and not
  detaching.
- `GET /roles?org=` → `{id, name, model?, tools: string[], mcp: string[], skills: string[]}[]`.
- `PUT /roles/:id?org=` body `{mcp?: string[], skills?: string[]}` (replace lists; validated
  against the catalog/skills) → the role row.
- `POST /mcp?org=` body `{id, description, tags?, server: McpServer, roles?: string[],
  replace?: boolean}` → `McpServerRow`; writes `catalog/<id>.yaml` (409 when it exists and
  `replace` is false) and attaches the roles.
- `DELETE /mcp/:id?org=` → `{removed:true}` after detaching from every role.
- `GET /registry/connectors` → `ConnectorTemplate[]`: `{id, name, vendor, verified, category,
  description, keys: {name, signupUrl?, description}[], server: McpServer, skills?: string[]}`.
- `GET /registry/skills` → `SkillSource[]`: `{repo, name, vendor, description, path?,
  categories?: string[]}`; the listing itself comes from `/skills/discover`.
- `GET /plugins` → `PluginRow[]`: `{id, name, description, status:'ready'|'partial'|'off',
  checks: {label, ok, detail?}[], keys: {name, present}[], actions: {id, label, href?}[],
  brings: {connectors: string[], skills: string[]}}` (Higgsfield reuses `HiggsfieldView`).
- `GET /keys` unchanged; the "needed by" is computed in the app from `/orgs/config`, `/roles`,
  `/mcp` and `/plugins`.

CLI: `shibaox skills list|add <repo|path> [--id …] [--org]|rm <id>`, `shibaox mcp add <id>
--url … | --command … [--key NAME…] [--role …]`, `shibaox mcp rm <id>`, `shibaox roles list`.

## Registries (built in, `packages/daemon/src/registry/`)

Connectors (official remote or well-known stdio servers; each with keys and categories):
Higgsfield (http, bearer_command, Design & media, verified), Playwright (`npx -y
@playwright/mcp`, Browser), GitHub (http `https://api.githubcopilot.com/mcp/`, header
`Authorization: Bearer ${GH_TOKEN}`, Code, verified), Context7 (http
`https://mcp.context7.com/mcp`, `CONTEXT7_API_KEY` optional, Docs), Fetch (`uvx mcp-server-fetch`,
Search), Filesystem (`npx -y @modelcontextprotocol/server-filesystem`, Data), Memory
(`npx -y @modelcontextprotocol/server-memory`, Productivity), Sequential thinking, Notion
(http `https://mcp.notion.com/mcp`, Productivity, verified), Linear (http
`https://mcp.linear.app/mcp`, verified), Sentry (http `https://mcp.sentry.dev/mcp`, Infra,
verified), Stripe (http `https://mcp.stripe.com`, `STRIPE_SECRET_KEY`), Supabase (http
`https://mcp.supabase.com/mcp`, Data, verified), Cloudflare docs (http
`https://docs.mcp.cloudflare.com/mcp`, Docs), Firecrawl (`npx -y firecrawl-mcp`,
`FIRECRAWL_API_KEY`, Search), Exa (http `https://mcp.exa.ai/mcp`, `EXA_API_KEY`, Search),
Brave Search (`npx -y @modelcontextprotocol/server-brave-search`, `BRAVE_API_KEY`), Postgres
(`npx -y @modelcontextprotocol/server-postgres`, `DATABASE_URL`, Data), Figma (http
`https://mcp.figma.com/mcp`, Design & media, verified), Vercel (http
`https://mcp.vercel.com`, Infra, verified), Slack (`npx -y @modelcontextprotocol/server-slack`,
`SLACK_BOT_TOKEN`, Productivity). Entries whose http servers use OAuth and have no key get
`keys: []` and a note "signs in on first use". The registry is data (a TS array) tested for
schema validity.

Skill sources: `anthropics/skills` (Anthropic, categories from folder names), `higgsfield-ai/
skills` (Higgsfield), `WizardingCode-io/shibaox` `org/skills` templates (Shibaox).

Revised after review: the Shibaox skill source is dropped; Postgres (archived, known read-only
bypass) and Slack (archived) are dropped; Brave is `@brave/brave-search-mcp-server`; Exa's key is
optional and goes in the URL (`?exaApiKey=…`), not a header; the OAuth entries say "signs in with
OAuth through the Claude Code runtime; the direct runtime cannot sign in yet".

## Design system additions (source `~/Projects/shibaox/design-system`, then sync)

Icons: `puzzle`, `key`, `lock`, `package`, `trash`, `sparkles`, `server`, `github`, `filter`,
`more-horizontal`, `arrow-up-down`, `check-circle`. New component **Segmented**
`{items:{id,label,dot?}[], value, onChange}` (pill group, 32 px, `surface-sunken`), used for
Yours | Discover. **Card** gets `meta?: ReactNode` (the small line under the description)
and `aside?: ReactNode` (actions on the right, top-aligned). `Input` with `type=password`
already exists. Previews + README updated for each.

## App structure

`apps/app/src/screens/customize/`: `CustomizeScreen.tsx` (header, tabs, routing),
`SkillsTab.tsx`, `ConnectorsTab.tsx`, `PluginsTab.tsx`, `KeysTab.tsx`, `ModelsTab.tsx`,
`dialogs/` (RolesDialog, ConnectorDialog, SkillRepoDialog, SkillWriteDialog, ConfirmDialog),
`needed-keys.ts` (pure: computes the Needed block from config/roles/mcp/plugins/models),
`filter.ts` (search + category). Store: `customize` slice loaded by `loadCustomize()`
(parallel fetch of skills, roles, mcp, models, keys, config, decisions, plugins, registries)
and mutations that reload. Old `IntegrationsScreen.tsx`/`SkillsScreen.tsx` removed.

## Tests

Daemon: skills list/add (repo via a local bare git repo in tmp, folder, inline; ids validated;
exists skipped; symlink refused; size cap), discover cache, delete with/without detach, roles
list/put (validation errors 400), mcp add (409 exists, replace), mcp delete detaches, registry
schema validity (every template parses with `CatalogEntrySchema`), plugins status with fake
checks, network callers refused for writes. CLI: skills/mcp add/rm/list output. App:
`needed-keys.test.ts` (pure), `customize.test.tsx` (tabs route, Yours/Discover, search,
category, add connector dialog → POST shape, roles dialog → PUT shape, keys needed ordering,
set key, model filter, redirect of old routes). DS: Segmented + icons render.

## Out of scope (noted)

A marketplace format of our own; editing SKILL.md in place (Open shows it; edit through the
files later); OAuth flows for http servers (they sign in on first use through the MCP client);
Linux/Windows plugins checks; per-project catalogs.
