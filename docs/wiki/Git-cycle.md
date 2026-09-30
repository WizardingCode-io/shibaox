# Git cycle

A `git` node is a step the daemon runs itself (trusted org configuration, like `code`), for **worktree runs**: `merge` and `pr` refuse an in-place run, and an in-place `commit` stages what is under the workspace only.

```yaml
ship:   { type: human, action: approve-push, prompt: "Land this on the base branch?", next: commit }
commit: { type: git, action: commit, next: merge }
merge:  { type: git, action: merge }
# or a pull request instead: pr: { type: git, action: pr }   (needs a remote "origin" and gh)
```

## commit

Commits the workspace with a message written by the `cheap` tier (else `strong`, else the run's model) from the request and the diff, or deterministic text when no model can be called from the daemon (Claude subscription tiers). `message:` fixes it. Every commit carries the trailer `Shibaox-Run: <runId>`. Hooks run; signing is off (the daemon has no TTY for a pinentry). Nothing to commit is an outcome (`committed: false`), not a failure.

## pr

Pushes the run branch and opens a pull request with `gh` (`--base`, `--head`, a title from the request's first line, a body written the same way as commit messages). An open pull request for the branch is reused. The base is `base:` on the node, else the branch the project was on when the run started, else the remote's default branch, else `main`.

## merge

Lands the run branch on the base through the project's **merge queue**: one merge at a time per project, in the order the runs asked.

1. Fetch; rebase the run branch on `origin/<base>` (the local base when there is no remote). A conflict aborts the rebase and fails the node.
2. When the base moved under the branch, run `tests:` (else the detected test command; `tests: ""` skips) on the rebased tree. The workflow's own gate already tested the branch.
3. Push `branch:base` first: the remote refuses anything but a fast-forward, so nothing local moves when that fails. Then the local checkout follows: a fast-forward when it is on the base and clean, else the ref is moved, else a note says `local <base> not updated: pull it`.

A failing test or a conflict leaves the base untouched. A cancelled run never lands. A workspace with uncommitted changes is refused (put a `commit` before `merge`). Nothing to land is an outcome (`merged: false`).

## review, comment, merge_pr

`review` (`from: <node>`, `event: comment|approve|request-changes`) publishes a node's text as a review of the run's pull request, `comment` posts a comment (`from` or `message`), `merge_pr` (`method: squash|merge|rebase`) merges it on GitHub and deletes the branch. The pull request is the one a `pr` node opened, else `#N` or a PR URL in the request. See [GitHub loop](GitHub-loop).

## Approvals

Git nodes push without asking: the workflow's `human` node before them is the approval. Agents themselves never push or deploy without an approval in the inbox (see [Security](Security)).

## Cleaning up

Worktrees are kept after the run. `shibaox worktree list --project .` and `shibaox worktree rm <runId> --project . --delete-branch` remove them. See [Worktrees](Worktrees).
