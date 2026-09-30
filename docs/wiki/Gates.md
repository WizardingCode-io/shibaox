# Gates

A gate is a file under `org/gates/` with a list of checks. A `gate` node runs gates in order; the first failing check stops the gate and the run takes `on_fail` (up to `max_retries` times, usually back to `implement` with the evidence and the suggestion), else `on_pass`. A team's `gates:` are injected into every workflow of the team that does not already cover them.

```yaml
gate: quality
checks:
  - { name: unit-tests, type: tests, timeout_ms: 120000 }
  - { name: lint, type: lint }
  - { name: review, type: review }
```

## Checks

| Type | What it does |
| --- | --- |
| `tests` | Runs the project's own test runner, detected in the workspace: `npm`/`pnpm`/`yarn`/`bun test` from `package.json`, `pytest`, `go test ./...`, `cargo test`, `make test`, `php artisan test` / `vendor/bin/phpunit`, `bundle exec rspec`. A project with none passes with a note. |
| `lint` | Runs the project's linter: `scripts.lint` through its package manager, else `make lint`, biome (`npx --no @biomejs/biome check .`), eslint (`npx --no eslint .`), ruff, phpstan, golangci-lint or `go vet`, clippy. `command:` fixes it. No linter, or one that is not installed where the daemon runs, is a skipped pass with a note, never a failure to fix. The linter's output is the evidence. |
| `review` | The judge model reviews the change criterion by criterion: `criteria:` (a list), else the built-in rubric — scope, correctness, tests, hygiene, clarity. Each criterion gets evidence and, when it fails, a suggestion the author can act on; a criterion the model does not answer counts as failed. The diff it sees includes new files. |
| `judge` | The judge model answers one `rubric` with passed / evidence / suggestion. |
| `jev` | A typed question to Jev (`question`, `kind: noul|score`, `threshold`), through TypeSafe's API (`TYPESAFE_API_KEY`). |
| `code` | A fixed command (`command: "pnpm typecheck"`, `timeout_ms`); exit 0 passes. |
| `human` | Asks you, with `prompt`. |
| `mock` | For tests: `passes: true|false`. |

The judge model is `gates.judge` in `models.yaml`, else the `decision` tier when it is a model ref, else `strong`. `judge` and `review` need a real adapter; with `mock` they fail and the run says so at submit.

## The template's gates

`tests.yaml`, `lint.yaml` and `review.yaml`. `hello-feature` and `land-feature` gate on `[tests]`. Add `lint` once the base branch is lint-clean (otherwise the agent is asked to fix the whole repository), and `review` for a model review before the human approval:

```yaml
qa: { type: gate, gates: [tests, lint, review], on_pass: judge, on_fail: implement, max_retries: 2 }
```

## What the agent gets back

A failing check's evidence (the test output, the linter's lines, the review's `✗ criterion: reason` lines) and its suggestion go to the next attempt of the rework node, and show as a card in the dashboard. Nothing the gate saw (files, diffs, output) is sent to notification channels; only the command, run, node and role.

`tests` and `lint` in the project's `shibaox.yaml` take precedence over detection (see [Configuration](Configuration)).
