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

A fresh worktree has no installed dependencies: the `setup` step below installs them first; the `tests` and `lint` checks still report a missing tool as a skipped pass, not a failure to fix.## Dependencies in a fresh worktree

A worktree starts without `node_modules`, `.venv` or `vendor`, so a run in worktree mode gets a `setup` node before its first step: a `code` node that runs the project's install command in the worktree. `shibaox.yaml setup` (read from the worktree, so it must be committed) comes first; otherwise the lockfile decides, and the install is frozen so it never writes a file a later `commit` node would pick up: `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `bun install --frozen-lockfile`, `npm ci` (or `npm install --no-package-lock` without a lockfile), `uv sync --frozen`, `composer install --no-interaction`, `go mod download`, `cargo fetch --locked`, `bundle install`. A project in a subdirectory of a monorepo installs where the lockfile is. Python without `uv.lock` or PHP without `composer.lock` gets no setup: put the right command in `shibaox.yaml`. Ten minutes by default (`setup_timeout_ms`). Tests and linters then run for real. The node is part of the run's workflow snapshot, so `replay` and `audit` show it; only the tail of its output reaches later prompts.

When the tool is not installed on the machine (`pnpm`, `uv`, `composer`, …) the step is skipped with a note and the run goes on, as the `tests` and `lint` checks do; any other failure of the install fails the run at step one, with the command and the last lines of its output. `shibaox run --setup off` skips it, `--setup "<command>"` replaces it, `setup: off` in `org.yaml` turns it off for every run of the org (the dashboard and routines have no flag), `setup: false` in `shibaox.yaml` turns it off for the project, and a workflow that has its own `setup` node is left alone. In-place runs never get one: the checkout already has its dependencies.

**What this runs.** The install runs through a shell as the daemon's user, with the process environment plus the GitHub token and git identity from the vault, before any model or person is involved, and every repository can name its own command in `shibaox.yaml` (and a `package.json` runs its `postinstall` scripts regardless). It is the same trust you give a project when you run `npm install` in it yourself: do not point a worktree run at a repository you would not install by hand, or set `setup: off` in the org until you have read it.
