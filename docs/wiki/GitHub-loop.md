# GitHub loop

From an issue to a merged pull request, with CI and your approval in between, and the outcome reported back on the issue.

```sh
shibaox run fix-issue --issue 12 --project .        # or --issue https://github.com/acme/app/issues/12
shibaox run review-pr --input "#13" --project .
```

A [routine](Routines) on `github:issues` starts one run per change in the set of labelled issues, with the list of issues as data (its origin is the routine, not an issue, so it reports where routines do); to work one issue at a time with the report on the issue, `run --issue`.

## `--issue`

`shibaox run <workflow> --issue N` reads the issue with `gh issue view` (of the project's repository, or of the URL's) and makes it the request: `Issue #N: title`, the URL, the labels and the body; `--input` adds to it. The run carries the origin `github:owner/repo#N`, so its report (status, nodes, cost, the pull request it opened, what it waits for) is posted as a comment on the issue by the `github` channel when the run ends or stops for you. Approvals are never asked on GitHub, only in the inbox, the dashboard and Telegram: a public issue is not a place to say yes.

## The `ci` check

```yaml
gate: ci
checks:
  - { name: github-checks, type: ci, timeout_ms: 1800000, interval_ms: 30000 }
```

Waits for the pull request's checks (`gh pr checks`, every `interval_ms`, up to `timeout_ms`) and passes when they all passed or were skipped; a failed check fails the gate with the check names and links as evidence, so the next `implement` attempt sees what broke. Right after a push the checks may not exist yet: the gate waits up to `grace_ms` (2 min) for them to appear before passing with a note; a pull request that cannot be read (no access, a 404) fails the gate. The pull request is the one the run's `pr` node opened, else a PR URL or `PR #N` in the request (an `Issue #N` is not one), else the run branch. A run with no pull request passes with a note.

## git nodes for pull requests

| Action | |
| --- | --- |
| `pr` | pushes the run branch and opens the pull request (an open one is reused) |
| `review` (`from`, `event`) | publishes the text of node `from` as a review: `comment` (default), `approve` or `request-changes` |
| `comment` (`from` or `message`) | posts a comment |
| `merge_pr` (`method`) | merges the pull request on GitHub (`squash` by default, `merge`, `rebase`) and deletes its branch |

`review`, `comment` and `merge_pr` take the pull request from the `pr` node or from the request (a PR URL or `PR #N`; the URL names the repository); unlike the `ci` check they have no branch fallback. Put a `human` node before `merge_pr` and before `review`: the template does. `merge_pr` leaves the remote branch (delete it on GitHub if you like); `shibaox worktree rm` cleans the local one.

## The template

- `fix-issue`: analyse → implement → tests → commit → pr → ci → **approve** → merge_pr.
- `review-pr`: a `reviewer` role (read and `gh` only, no write) reads the diff and writes the review → **approve** → the review is published as a comment on the pull request.
- `reviewer` role, `ci` gate.

## `gh` and approvals

In both runtimes `gh` runs under an allowlist. Reads run freely: `pr view|diff|checks|list|status`, `issue view|list|status`, `repo view|list`, `run view|list|watch`, `release view|list|download`, `workflow view|list`, `label list`, `gist view|list`, `search …`, `status`, `gh api` with GET and no fields (a GraphQL query, not a mutation). Everything else is a `deploy` that needs an approval from a role listing it, whatever the flags look like (`-R owner/repo`, `-XDELETE`, `-fbody=`): merges, closes, reviews and comments (so a review is published only after the human node), releases, repository settings, secrets, workflow runs, writing API calls, and any subcommand not on the read list. What would hand out code execution, files or the token is refused outright: `extension`, `alias`, `auth`, `config`, `ssh-key`, `gpg-key`, `repo deploy-key`, `gist create`, `codespace`, `browse`. `gh` runs with the `GH_TOKEN` of the vault in git nodes, gates, routines and the `github` channel.
