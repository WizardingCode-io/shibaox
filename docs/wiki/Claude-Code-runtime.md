# Claude Code runtime

`--adapter claude-code` (or `adapter: claude-code` in `org.yaml`, or a `/model` choice of an `anthropic-subscription/...` model) runs task nodes through Claude Code via the Claude Agent SDK. It keeps the org's routing: a role whose model is `anthropic-subscription/<model>`, or `anthropic/<model>` for a role whose `runtime` is `claude-code` (the default), runs in Claude Code with that model; any other role (for example `ollama/...`) still runs on the direct adapter. Every role is resolved before the run starts; one that cannot run stops it with `cannot start: ...`.

## Subscription vs API key

`anthropic-subscription/...` uses the login of the `claude` CLI (`claude` must be installed and signed in): for these roles Shibaox removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the Claude Code process, so an API key in your shell is not billed. With `anthropic/...` the process gets `ANTHROPIC_API_KEY`. Each task prints `claude-code ready: model=<model> apiKeySource=<source> ...`. The Claude Code process only inherits `PATH`, `HOME`, locale and terminal variables, `SSH_AUTH_SOCK` and `ANTHROPIC_*` / `CLAUDE_CODE_*`; other secrets stay in Shibaox.

## Tools

A role's `tools:` map to Claude Code permissions: `read` → Read/Glob/Grep, `write` → Edit/Write/MultiEdit/NotebookEdit, any other name → `Bash(<name> *)`. File tools get no blanket allow: each call is allowed only when its path resolves, through symlinks, inside the task's working directory; `~`, `..` and absolute paths elsewhere are denied, and writes under `.git` are denied. `WebFetch` and `WebSearch` are allowed only for the hosts in `permissions.network`. Compound shell commands (`;`, `&&`, pipes, substitutions) are refused. `rm -rf` is always denied.

## Push and deploy

`git` and the deploy programs below never get a blanket allow: every call is classified, and a push or deploy is refused unless the role lists it in `permissions.approval_required` and a human approves it at that moment (in the inbox, the dashboard or Telegram). Gated programs must be called by bare name and without shell expansion.

| Program | Deploy verbs |
| --- | --- |
| `vercel` | `deploy`, `redeploy`, `promote`, `rollback`, `alias`, `remove`, `rm`; also bare `vercel`, `vercel <dir>`, `vercel --prod` |
| `fly`, `flyctl` | `launch`, `deploy` |
| `netlify` | `deploy` |
| `heroku` | `deploy`, `container:push`, `container:release`, `releases:rollback` |
| `railway` | `up`, `deploy` |
| `wrangler` | `deploy`, `publish` |
| `kubectl` | `apply`, `create`, `replace`, `patch`, `scale`, `set`, `edit`, `delete`, `rollout` |
| `terraform` | `apply`, `destroy`, `import`, `state` |
| `helm` | `install`, `upgrade`, `uninstall`, `rollback` |
| `npm`, `pnpm`, `yarn` | `publish`, `unpublish`, `dist-tag`, `dist-tags`, `deprecate` |
| `docker` | `push`, and any invocation with `--push` |

git pushes are `git push`, `git send-pack`, `git subtree push` and `git lfs push`. The git classifier fails closed: unknown global options, `-c`, `--config-env`, `git config` writes, options that run programs (`--exec`, `--upload-pack`, `rebase -x`, `submodule foreach`, `bisect run`, …), unknown subcommands and aliases, and `GIT_*` environment prefixes (other than author/committer) are refused. `gh` runs under an allowlist: `pr view|diff|checks|list`, `issue view|list`, `repo view`, `run list|view`, `release view|list|download`, `search`, GET `gh api` calls read freely; everything else (merge, review, comment, release, repo, secret, workflow run, writing API calls) is a deploy; `extension`, `alias`, `auth`, `config`, keys, `gist create`, `codespace` and `browse` are refused ([GitHub loop](GitHub-loop)).

## Sessions and approvals

A push or deploy inside a task waits on the request; an approval applies to that exact command on that node. If nobody answers within the approval timeout, or the daemon restarts, the task is suspended with its session id and resumed after the answer, with a short note telling the session what was decided.

Settings files (`~/.claude`, project `.claude/`) are not loaded; the role prompt from `system_prompt` is appended to Claude Code's own system prompt.

## Budget

Spend reported by Claude Code counts against the run budget, and the remaining budget caps each task. For subscription roles this spend is notional (a USD equivalent even though the subscription charges nothing per call). When a task hits the cap the run pauses instead of failing; `shibaox resume <runId> --budget <higher>` re-runs that task.

## Subscription-only orgs

`decide` nodes and `judge`/`review` checks call a model directly, and a subscription model is only reachable through Claude Code. In an org whose models are all subscription models, `decide` nodes fall back to always choosing `ship` and model checks cannot run, unless `tiers.decision` names a model ref another provider serves (for example `openrouter/typesafe/jev-router`) or `TYPESAFE_API_KEY` is set.

See [Security](Security) for what these rules are and are not.
