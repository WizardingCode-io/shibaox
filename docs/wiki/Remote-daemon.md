# Remote daemon

The daemon can run on another machine, a VPS or a Mac mini that stays on, and the CLI, the dashboard and Telegram reach it from wherever you are. Runs keep landing with your laptop closed.

## On the server

```sh
shibaox keys set SHIBAOX_DAEMON_TOKEN $(openssl rand -hex 32)   # the token clients will present
shibaox serve                                                     # 0.0.0.0:7433, in the foreground
```

`shibaox serve` is `daemon start` with a network listener: the same API as the local socket, on TCP, and every request must carry `Authorization: Bearer <token>`. The token is read from the vault or from the environment (`SHIBAOX_DAEMON_TOKEN`); without one `serve` refuses to start. `keys set` starts the local daemon to store the key: stop it (`shibaox daemon stop`) before `serve`, or export the token instead (`SHIBAOX_DAEMON_TOKEN=… shibaox serve`). `--host` and `--port` override the defaults; `daemon.yaml listen` makes them permanent, so a `daemon start` or the launchd service listens too:

```yaml
listen:
  host: 0.0.0.0
  port: 7433
  token_env: SHIBAOX_DAEMON_TOKEN      # default
  # tls: { cert: ./cert.pem, key: ./key.pem }
projects:                              # what a remote dashboard offers as projects
  - /srv/app
  - /srv/other
```

Without `listen` nothing changes: the daemon answers on its 0600 socket only. Note the defaults: `serve` binds `0.0.0.0` unless told otherwise, while `listen.host` in `daemon.yaml` defaults to `127.0.0.1` (loopback: for an SSH tunnel, or a reverse proxy on the same machine); set `host: 0.0.0.0` there for the service to answer the network.

A request with no token gets a reduced `GET /health` (`{ version }`) so a monitor can watch the daemon; a wrong token is `401` everywhere, including `/health`.

### In Docker

`docker run -d -p 7433:7433 -e SHIBAOX_DAEMON_TOKEN=… -v shibaox-data:/data -v /srv/projects:/projects ghcr.io/wizardingcode-io/shibaox` is `shibaox serve` in a container (see [Installation](Installation)); `docker-compose.yml` in the repository is the same with a `.env`. Provider keys go into the vault over the API once the remote is set (`shibaox keys set …`), or into the container's environment. For `anthropic-subscription` roles log Claude Code in once inside the container: `docker exec -it shibaox claude` (its config lives in `/data/claude`). To push over SSH, mount a key read-only into `/home/shibaox/.ssh`.

## On your machine

```sh
shibaox remote set http://box.example:7433 <token>   # saved in ~/.shibaox/remote.json (0600)
shibaox doctor                                      # daemon: remote http://box.example:7433, version 0.1.7
shibaox                                             # the dashboard, on the remote
shibaox remote show | clear
```

From then on every command goes to the remote. `--remote <url>` or `SHIBAOX_REMOTE` (with `SHIBAOX_REMOTE_TOKEN`; the saved token is reused only when the URL is the one it was saved for) override the file for one command or one shell; `SHIBAOX_REMOTE=` empty in a script means "the file, or local". Prefer piping the token (`echo $TOKEN | shibaox remote set <url>`) to typing it on the command line, where the shell history and `ps` see it.

With a remote set, the CLI never starts or restarts a daemon: a remote that does not answer, refuses the token or is older than the CLI is explained, and you fix it on the server (`shibaox upgrade` there, or `npm i -g shibaox@latest`, then restart `serve`). `daemon start|stop|install` stay local commands.

## The dashboard on a remote

The dashboard reads nothing from your disk when it talks to a remote: the project list comes from `daemon.yaml projects` on the server, the projects of recent runs and the daemon's own workspace; the org is the daemon's default org (or `/org <absolute path on the server>`); `/project` takes an absolute path on the server and the daemon checks it exists. The footer names the remote (`remote box.example:7433`). Runs, approvals, diffs, keys and tiers work as they do locally, over the API.

## What a token is

**A daemon token is shell access on that machine as the user running the daemon.** The API takes any org and any project path, a task runs the programs its role lists, and a `code` node runs commands. Treat the token as you treat an SSH key: one per person or machine when you can (rotate by changing the vault key and restarting `serve`), never in a repository, never in a chat.

Plain HTTP sends the token in clear at every request. Use it only on a loopback or a private network you trust, or through an SSH tunnel (`ssh -L 7433:127.0.0.1:7433 box`, then `remote set http://127.0.0.1:7433 …`) or a VPN; on the open internet put TLS in front (a reverse proxy, or `listen.tls` with a certificate). `remote set` and `serve` both say so when the URL is plain HTTP to another host.

Behind a reverse proxy, let the event stream through: it is server-sent events, so turn response buffering off (`proxy_buffering off` in nginx) and allow long reads; the daemon sends a heartbeat comment every 20 s so idle timeouts of a minute or more never cut a run that waits on you, and `shibaox follow` reopens a cut stream where it left off.

Keys stay in the vault on the server (`shibaox keys set` from your machine sets them there over the API, masked in every listing); a remote dashboard sees masked keys only.
