# Memory

## The vault

`vault:` in `org.yaml` (relative to the org directory; `shibaox init` writes `vault: ../vault`, the default org uses `~/.shibaox/vault`) points at an Obsidian vault. When a run ends (`completed`, `failed` or `cancelled`), Shibaox writes `10-projects/<project>/runs/<date>-<runId8>.md` (status, adapter, spend, nodes, last gate report, timeline) and one `90-system/decisions/<date>-<runId8>-<node>.md` per `decide` node, and prints `note: <path>`. Notes are never overwritten. Without `vault:` the run prints one warning.

## Profile, remember and recall

`10-projects/<project>/profile.md` is rewritten whenever the project is profiled (the dashboard home, every run). Roles with the `memory` capability get `remember({ scope, text })` and `recall({ query })`: `scope: user` appends to `00-org/memory.md`, `scope: project` to `10-projects/<project>/memory.md` (dated bullet lines); `recall` returns the lines containing every word of the query. The last 40 lines of each note (4 kB at most) plus the profile line open every task's prompt, quoted as data.

## graphify

A code knowledge graph of the project, built with [graphify](https://pypi.org/project/graphifyy/) (`uv tool install graphifyy`; `graph build` tries this itself when `uv` is present):

```sh
shibaox graph build --project ./project      # writes ./project/graphify-out/graph.json
shibaox graph update --project ./project     # after code changes
shibaox graph query "where is add defined?" --project ./project
```

`run --graph auto` (the default) uses `graphify-out/graph.json` when it exists and never builds it: direct roles get a `graph_query` tool, and Claude Code roles get the graphify MCP server (which needs graphify's Python; a warning is printed and the MCP is skipped when it cannot be found). `--graph off` disables both.

## Autorouting

Once per run, Shibaox matches the org's catalog (`org/catalog/*.yaml` entries of type `skill`, `plugin`, `mcp` or `tool`) against the first task role of the workflow and prints `autoroute: attach=[...] ambiguous=[...]`. Without `TYPESAFE_API_KEY` the match is by tags; with the key (and a non-mock adapter) Jev scores each candidate and attaches those at 0.8 or more. Today the result gates the graphify MCP: when the catalog lists `graphify-mcp`, it is attached only if autorouting attaches it.

## Where state lives

Events are stored in `~/.shibaox/events.db` (SQLite, WAL mode; `$SHIBAOX_HOME` moves the directory), written only by the daemon. `shibaox replay <runId> --db <path>` reads a database offline. Deleting the file deletes the run history. Run worktrees live under `<project>/.shibaox/worktrees/`, run notes in the vault.
