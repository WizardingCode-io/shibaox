# Worktrees

`run --workspace worktree|inplace` picks where tasks work. The default is `worktree` when the project is a git repository, else `inplace`. Conversations (`conversation: true` workflows) always run in place.

A worktree run gets its own checkout at `<project>/.shibaox/worktrees/<runId>` on a new branch `shibaox/<runId>` created from the project's `HEAD` (uncommitted changes in the project are not in it). `.shibaox/` and `graphify-out/` are added to `.git/info/exclude`. The main checkout is never touched: the change comes back through a `git` node (commit and merge, or a pull request) or by hand.

If the project is a subdirectory of a larger repository, tasks run in the same subdirectory of the worktree. A worktree needs a commit, and a subdirectory project must be tracked at `HEAD`: when the default cannot be used the run prints `warn: <reason>; running in place`; an explicit `--workspace worktree` is refused instead.

The branch the project was on when the run started is recorded (`baseBranch`): it is where `merge` lands by default. See [Git cycle](Git-cycle).

Worktrees are kept after the run (`worktree: <path> (branch shibaox/<runId>)`):

```sh
shibaox worktree list --project ./project
shibaox worktree rm <runId> --project ./project [--delete-branch]
```

A fresh worktree has no installed dependencies: a `pnpm` project's tests or linter may fail there until a setup step exists (the `tests` and `lint` checks report a missing tool as a skipped pass, not a failure to fix). Installing dependencies in the worktree is on the roadmap.

## Dependencies in a fresh worktree

A worktree starts without `node_modules`, `.venv` or `vendor`, so a run in worktree mode gets a `setup` node before its first step: a `code` node that runs the project's install command in the worktree (`shibaox.yaml setup`, else what the lockfile says: `pnpm install --frozen-lockfile`, `npm ci`, `uv sync`, `composer install`, `go mod download`, …; ten minutes by default, `setup_timeout_ms` to change it). Tests and linters then run for real. The node is part of the run's workflow snapshot, so `replay` and `audit` show it. `shibaox run --setup off` skips it, `--setup "<command>"` replaces it, `setup: false` in `shibaox.yaml` turns it off for the project, and a workflow that has its own `setup` node is left alone. In-place runs never get one: the checkout already has its dependencies.
