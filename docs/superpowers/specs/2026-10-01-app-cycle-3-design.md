# App cycle 3: dialogs that fit, code that becomes files, decisions you can see

2026-10-01. Three things Andre hit in 0.2.4: the Create routine dialog is taller than the window
(no way to reach Save); a reply with a script or a CSV is just a code block ("we must be more
dynamic: at least let me generate the file"); nothing shows whether Jev (the decision tier) is at
work. Ships as 0.2.6 on one branch.

## A. Dialogs fit the window (design system)

`.sx-dialog` is capped at the viewport (`100dvh` minus the scrim padding) and may shrink
(`min-height: 0`); the body scrolls, head and footer stay; `.sx-scrim` scrolls as a last resort.
Verified in Playwright at 1180×700: the footer of Create routine is visible, the body scrolls.

## B. Code becomes a file

- Design system `CodeBlock` gets an `actions` slot in its bar (before Copy).
- The Markdown renderer takes `onOpenCode?(code: { text, lang?, name })`; with it every code
  block (and every CSV table) offers **Open** (icon `external-link`) which opens the side panel.
  The name comes from `suggestName(text, lang, info)` in `apps/app/src/markdown/filename.ts`:
  a filename in the fence info (```js fibonacci.js), else a `// file: x` / `# file: x` first
  line, else the first `function`/`class`/`def` name with the language's extension, else
  `snippet.<ext>` (csv → `table.csv`, md → `notes.md`, json → `data.json`, sh → `script.sh`).
- `FileSheet` takes either a run file (`runId` + `path`, as today) or an inline one
  (`inline: { name, content, lang? }`): Copy and Download work on both; an inline file in a
  conversation that has a run with a workspace also shows **Save to project**: a path field
  (prefilled with the name) and a Save button → `PUT /runs/:id/files/content?path=` with the
  text as the body → on success the sheet shows "Saved to <path>" and becomes that run file.
- Daemon: `writeRunFile(root, path, content, { protectedGlobs, maxBytes })` in `runs/files.ts`
  (confined to the workspace with the same rules as reads: never `..`, never through a symlink
  out, never a protected file; parent directories created; utf8; 2 MB cap → 413);
  `RunManager.writeFile(runId, path, content)` writes and records a `file_changed` runtime event
  under node `you`, so the file shows under Outputs and in `shibaox files`. Route
  `PUT /runs/:id/files/content?path=` (text body; 403 protected/outside, 404 no workspace,
  413 too large, 409 when the run is still running: its task owns the workspace). The daemon
  token already is shell access, so no new approval is asked. Client `writeFile`.
- The orchestrator prompt (template + Andre's org): a request for a file, a script, a document
  or data is answered by creating it in the workspace with `write_file` and saying where it is;
  code in the reply is for reading, not the deliverable.

## C. Decisions you can see

- `DecisionMade` carries `by` (who decided: `jev` for the TypeSafe typed API, `model:<ref>` for
  an LLM decider such as `openrouter/typesafe/jev-router`, `scripted`); the Decider
  interface returns `by`; reducer and the view's decide card carry it; the Tasks tab says
  "Decision · <node>: <choice> · 92% · by openrouter/typesafe/jev-router".
- `GET /decisions?limit=20`: the decider in use (`{ kind: 'jev' | 'model' | 'none', ref?,
  usable, reason? }`) and the latest decisions across runs (`{ runId, nodeId, choice,
  confidence, by, at }`), read from the last 50 runs of the store.
- Integrations → **Decisions** (above Tiers): "Decisions and the judge go through
  openrouter/typesafe/jev-router (configured)" or the reason it is not usable, "No decision
  yet: the chat workflow has none; decide nodes and gates with a judge use it", and the recent
  decisions with a link to each conversation. `shibaox doctor` gets a `decisions` line.
- Each agent message shows the model that wrote it (muted, after the time): from the run's
  `usage` runtime event, else the run's chosen model, else nothing.
