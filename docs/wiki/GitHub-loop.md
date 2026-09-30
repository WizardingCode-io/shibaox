# GitHub loop

From an issue to a merged pull request, with CI and your approval in between, and the outcome reported back on the issue.

```sh
shibaox run fix-issue --issue 12 --project .        # or --issue https://github.com/acme/app/issues/12
shibaox run review-pr --input "#13" --project .
shibaox routine add fix-issue --on github:issues --label bug --org ./org --project .   # every labelled issue, unattended
```

## `--issue`

`shibaox run <workflow> --issue N` reads the issue with `gh issue view` (of the project's repository, or of the URL's) and makes it the request: `Issue #N: title`, the URL, the labels and the body; `--input` adds to it. The run carries the origin `github:owner/repo#N`, so its report (status, nodes, cost, the pull request it opened, what it waits for) is posted as a comment on the issue by the `github` channel when the run ends or stops for you. Approvals are never asked on GitHub, only in the inbox, the dashboard and Telegram: a public issue is not a place to say yes.

## The `ci` check

```yaml
gate: ci
checks:
  - { name: github-checks, type: ci, timeout_ms: 1800000, interval_ms: 30000 }
```

Waits for the pull request's checks (`gh pr checks`, every `interval_ms`, up to `timeout_ms`) and passes when they all passed or were skipped; a failed check fails the gate with the check names and links as evidence, so the next `implement` attempt sees what broke. The pull request is the one the run's `pr` node opened, else `#N` or a PR URL in the request, else the run branch. A run with no pull request passes with a note.

## git nodes for pull requests

| Action | |
| --- | --- |
| `pr` | pushes the run branch and opens the pull request (an open one is reused) |
| `review` (`from`, `event`) | publishes the text of node `from` as a review: `comment` (default), `approve` or `request-changes` |
| `comment` (`from` or `message`) | posts a comment |
| `merge_pr` (`method`) | merges the pull request on GitHub (`squash` by default, `merge`, `rebase`) and deletes its branch |

`review`, `comment` and `merge_pr` find the pull request the same way the `ci` check does. Put a `human` node before `merge_pr` and before `review`: the template does.

## The template

- `fix-issue`: analyse → implement → tests → commit → pr → ci → **approve** → merge_pr.
- `review-pr`: a `reviewer` role (read and `gh` only, no write) reads the diff and writes the review → **approve** → the review is published as a comment on the pull request.
- `reviewer` role, `ci` gate.

## `gh` and approvals

In both runtimes `gh` is classified like a deploy program: `gh pr merge`, `gh release create|delete|upload|edit`, `gh repo delete|edit|create|archive|rename`, `gh secret set|delete`, `gh variable set|delete`, `gh workflow run|enable|disable`, `gh ruleset …`, `gh label …`, and `gh api` with a method other than GET or with fields, all need a `deploy` approval from a role that lists it; reading, `gh pr review`, `gh pr comment` and `gh issue comment` do not. `gh` runs with the `GH_TOKEN` of the vault in git nodes, gates, routines and the `github` channel.
