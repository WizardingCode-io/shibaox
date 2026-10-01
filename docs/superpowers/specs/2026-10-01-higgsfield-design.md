# Higgsfield: images, video and audio from Shibaox (0.2.8)

2026-10-01. Andre: generation of images and videos is core; integrate Higgsfield completely (their
official MCP and the CLI), fluid, with his affiliate link for people who need an account
(https://higgsfield.ai?fpr=andre-4fae29). Plus: the model picker needs a search box.

## What a user gets
- Ask Shibaox for an image, a video, a voice: it generates it with Higgsfield and the result lands
  in the conversation as a file (image preview, video player, audio), saved in the workspace under
  `outputs/`, with the cost in credits. It never says "I cannot generate images".
- Integrations → **Higgsfield** card: CLI installed (version) · logged in as `<email>`, plan, credits ·
  MCP reachable · buttons: **Log in** (the daemon runs `higgsfield auth login`: the browser opens on
  that machine), **Install the CLI** (one command shown), **Create an account** (the affiliate link),
  **Open Higgsfield**. `shibaox doctor` gets a `higgsfield` line.
- Model picker: a search box filters the list (name or provider).

## How
- **Catalog entry `higgsfield`** (scaffold + Andre's org): `type: mcp`, http
  `https://mcp.higgsfield.ai/mcp`, `bearer_command: [higgsfield, auth, token]` (new McpServer field:
  a command whose stdout is the bearer token, run by the daemon before each connect, so the CLI's
  OAuth login is the only login), `tools:` allowlist (the headless subset: models_explore, generate_image_batch,
  generate_video_batch, generate_audio_batch, generate_3d, jobs_wait, show_generation_by_ids,
  show_generations, media_import_url, get_presets, execute_preset, list_voices, reframe,
  voice_change), `timeout_ms: 180000`. A failing bearer command skips the server with a note;
  the token is a secret of the connection (an env var for Claude Code), never on an argv.
- **Role `assistant`**: `mcp: [higgsfield]`, `skills: [higgsfield]`, `tools: + higgsfield`.
- **Skill `skills/higgsfield/SKILL.md`** (scaffold + Andre's org): when to use; defaults
  (gpt_image_2_5 images, seedance_2_5 video, nano_banana_flash cartoons, seed_audio audio;
  cheaper on request); flow: models_explore when unsure → generate_* → jobs_wait → download each
  result with `download_file` into `outputs/<slug>-<n>.<ext>` → answer with the path and credits;
  CLI alternative (`higgsfield generate create <model> --prompt … --wait --json`); not logged in →
  tell the user to log in from Integrations.
- **Direct runtime tool `download_file(url, path)`**: https only, hosts by the role's network policy
  (same approval as web_fetch), writes under the workspace (protected globs refused), 200 MB cap,
  reports size and mime; emits `file_changed`.
- **PATH for runs**: the daemon's command environment gets `~/.local/bin`, `/opt/homebrew/bin`,
  `/usr/local/bin` appended when missing (the service's PATH is minimal).
- **Daemon** `GET /integrations/higgsfield` → `{ cli: {installed, version, path}, account?: {email,
  plan, credits}, loggedIn, mcp: 'ok'|'unauthorized'|'unreachable', signupUrl, installCommand }`
  (probes `higgsfield version`, `account status --json`, and the MCP initialize with the token;
  cached 60 s); `POST /integrations/higgsfield/login` spawns `higgsfield auth login` detached
  (socket and loopback only; 409 when the CLI is missing). `daemon.yaml`
  `partners.higgsfield.signup_url` overrides the affiliate link (default Andre's).
- **App**: Integrations card; FileSheet previews video (`<video>` from a Blob) and audio; the model
  menu gets a search field (DS `MenuList` `search` prop: an input above the items filtering by
  label/hint, arrows and Enter still work).
- **Orchestrator prompt**: "Images, video, audio: generate them with Higgsfield (its tools or the
  CLI) and save the files in the workspace; never say you cannot."
- **Docs**: wiki Integrations/App/CLI/Security (what the bearer command does; credits are spent on
  the user's Higgsfield account).
- **Live validation**: `shibaox doctor` line, Integrations card on Andre's daemon, one image with
  gpt_image_2_5 (0.25 credits) from the app, shown as a chip and previewed.
