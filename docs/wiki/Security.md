# Security

Shibaox runs agents on your machine with your user's permissions. These are the rules it enforces, and what they are not.

## What is enforced

- **Tools by allowlist.** A role runs only the programs listed in its `tools:`. The direct adapter splits the command into argv and runs it without a shell: nothing is expanded (`$VAR`, `~`, globs), operators (`; & | $ < >`, backticks) are refused, and arguments that are absolute, start with `~`, contain `..` or name `.git` are refused. The child gets a scrubbed environment (`PATH`, `HOME`, `LANG`, `TMPDIR`, `TERM`). `write_file` refuses any path with a `.git` segment.
- **Files inside the workspace.** Read and write tools, and Claude Code's file tools, are allowed only for paths that resolve, through symlinks, inside the task's working directory.
- **Network by host.** `web_fetch`, `WebFetch` and `WebSearch` only for the hosts in `permissions.network`, redirects included.
- **Push and deploy ask first.** `git push`, `npm publish`, `vercel deploy`, `kubectl apply`, `terraform apply`, `docker push` and the rest (see [Claude Code runtime](Claude-Code-runtime)) are refused unless the role lists `push`/`deploy` in `permissions.approval_required` and you approve that exact command, in the inbox, the dashboard or Telegram. `gh` runs under an allowlist: reads run freely, everything else (merges, reviews, comments, releases, repository settings, secrets, workflow runs, writing API calls) is a deploy that needs an approval, and extensions, aliases, auth, keys, gists and codespaces are refused ([GitHub loop](GitHub-loop)).
- **Routines run on the daemon's machine.** A `command` trigger runs a shell command and a `file` trigger reads a file there, every interval, with the daemon's rights and the GitHub token: they are accepted from the socket or from `org/routines` files, never from a remote client; `url` triggers reach public addresses only. What a trigger saw is handed to the run as data. See [Routines](Routines).
- **The setup step runs what the repository says.** A worktree run installs dependencies first (`shibaox.yaml setup`, else the lockfile's frozen install) through a shell, as the daemon's user, with the GitHub token from the vault, before any model or person is involved; a `package.json` runs its own install scripts. Only run worktree runs on repositories you would `npm install` by hand, or set `setup: off` in `org.yaml`. See [Worktrees](Worktrees).
- **Git nodes land only after a human node.** The template puts `approve-push` before `commit` and `merge`; a cancelled run never lands.
- **Keys stay in Shibaox.** The vault is a 0600 file in a 0700 directory; runtimes get only the keys they need; channels never receive file contents, diffs or tool output; the socket is 0600 and local. `code` nodes, gate commands (`tests`, `lint`, `code`) and `git` nodes run with the process environment plus a short list from the vault: `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, the git author and committer variables and `SSH_AUTH_SOCK`. Never the provider keys: a test the model wrote runs there, and its output becomes evidence.
- **The network listener needs a token.** With `listen` in `daemon.yaml` (or `shibaox serve`) the API answers on TCP only to requests with the bearer token, compared in constant time; without a token the daemon refuses to listen; a request with no token gets the version and nothing else.
- **Everything is on the record.** Every tool call, approval and decision is an event in the run log, kept on disk across restarts; `shibaox audit <runId>` writes it out as a document (who approved what through which channel, every tool call with its duration, every gate with its evidence, what git did, the cost per node).

## What is not

**A daemon token is shell access** on the machine that runs the daemon, as that user: the API takes any org and any project path, and tasks run programs. Keep it like an SSH key, send it over TLS, an SSH tunnel or a VPN only, and rotate it by changing the vault key and restarting `serve`. See [Remote daemon](Remote-daemon).

An allowlist is **not a sandbox**. An allowed program such as `node`, `pnpm` or `make` can run arbitrary code: a `package.json` script, `node -e`, a script the task wrote. Claude Code's Bash tool snapshots your shell rc files, so anything they export can reach the task's shell. Cancelling a run does not kill a command that is already running. Only list programs you would let the model run unattended, and run Shibaox on projects and machines where that is acceptable.

Model outputs (summaries, review verdicts, commit messages) are quoted as data in later prompts, but a model can be steered by what it reads in your repository or on the web. Keep `permissions.network` narrow and review what lands.
