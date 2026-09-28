# Configuration

## `org/org.yaml`

```yaml
organization: my-org
teams: [engineering]
budgets: { per_run_usd: 5 }     # default run budget; --budget overrides
max_concurrent_runs: 2          # runs of this org at once
adapter: direct                 # mock | direct | claude-code; a chosen model overrides it
vault: ../vault                 # Obsidian vault, relative to the org directory
```

## `org/models.yaml`

```yaml
providers: {}
tiers:
  strong: anthropic/claude-sonnet-5
  cheap: openrouter/qwen/qwen3-coder
  decision: openrouter/typesafe/jev-router   # or jev-latest with TYPESAFE_API_KEY
roles:
  backend: { model: openai/gpt-5 }           # per-role override
gates:
  judge: anthropic/claude-haiku-4-5          # judge and review checks
```

`shibaox tiers` / `shibaox tiers set` and `/tiers` in the dashboard edit tiers, judge, adapter and budget without touching the files by hand (comments are kept).

## `org/teams/<team>.yaml`

```yaml
team: engineering
lead: team-leader
roles: [team-leader, analyst, backend]
gates: [tests]                    # injected into every workflow of the team
workflows: [hello-feature, land-feature]
```

## `org/roles/<role>.yaml`

```yaml
role: backend
description: Implements changes with tests.
system_prompt: prompts/backend.md   # optional, relative to the org
model_tier: strong                  # strong | cheap
runtime: claude-code                # optional: which runtime an anthropic/ model uses
tools: [read, write, git, node, pnpm]
permissions:
  fs: [workspace]
  network: [github.com]             # hosts it may fetch; '*' = any
  approval_required: [push, deploy]
capabilities: [orchestrate, memory] # start_workflow; remember/recall
max_steps: 12                       # direct adapter tool-loop steps
max_turns: 60                       # Claude Code agent turns
budget_usd: 1                       # cap per task within the run budget
```

## `org/workflows/<workflow>.yaml`

```yaml
workflow: land-feature
team: engineering
description: Analyse, implement, test, judge, approve, commit and land.
start: analyse
nodes:
  analyse:   { type: task, role: analyst, instruction: "Analyse the request and list the files to touch.", next: implement }
  implement: { type: task, role: backend, instruction: "Implement the request. Keep tests green.", next: qa }
  qa:        { type: gate, gates: [tests], on_pass: judge, on_fail: implement, max_retries: 2 }
  judge:     { type: decide, by: team-leader, question: "Is the work ready to ship?", options: [ship, rework], next: { ship: ship, rework: implement } }
  ship:      { type: human, action: approve-push, prompt: "Land this on the base branch?", next: commit }
  commit:    { type: git, action: commit, next: merge }
  merge:     { type: git, action: merge }
```

`conversation: true` marks a chat workflow (one task, in place, the thread carried between turns). See [Concepts](Concepts) for every node type and [Gates](Gates) for `org/gates/*.yaml`.

## `~/.shibaox/daemon.yaml`

Every key optional:

```yaml
max_concurrent_runs: 4
approval_timeout_minutes: 120
channels:
  macos: { enabled: true }
  telegram:
    bot_token_env: SHIBAOX_TELEGRAM_TOKEN
    chat_id: 123456789
    org: ./org                  # relative paths resolve next to this file
    project: /path/to/project
    workflow: chat
    # adapter: claude-code
```

## Environment

| Variable | |
| --- | --- |
| `SHIBAOX_HOME` | the home directory (default `~/.shibaox`) |
| `SHIBAOX_NO_AUTOSTART=1` | never start the daemon on demand |
| `SHIBAOX_NO_MOTION=1` | no animations in the dashboard |
| `SHIBAOX_APP` | the installer checkout (`shibaox upgrade`) |
| `TYPESAFE_API_KEY`, `SHIBAOX_JEV_BASE_URL` | Jev through TypeSafe |
| `SHIBAOX_REAL_TESTS=1` | enables the real-call tests |

Provider keys belong in the vault (`shibaox keys set`); the environment stays a fallback.
