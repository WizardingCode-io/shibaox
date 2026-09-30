# Installation

## One command

```sh
curl -fsSL https://raw.githubusercontent.com/WizardingCode-io/shibaox/main/scripts/install.sh | sh
```

The installer keeps one checkout under `~/.shibaox/app`, builds it, and puts `shibaox` on your PATH (`~/.shibaox/bin/shibaox`). It needs:

- **git**
- **Node 22 or later** (nodejs.org, nvm, or `brew install node`)
- **pnpm** (enabled through corepack when missing)
- **Bun 1.3+** for the dashboard (https://bun.sh). The CLI and the daemon work without it.

What it changes on your machine:

- `~/.shibaox/app` — the checkout; `~/.shibaox/bin/shibaox` — a launcher on the Node it was built with; `~/.shibaox/install.log` — the install and build output.
- One `export PATH="$HOME/.shibaox/bin:$PATH"` line in your shell's login file: `~/.zprofile` (macOS zsh), `~/.bash_profile`, or `~/.zshrc`/`~/.bashrc` on Linux. `SHIBAOX_NO_PROFILE=1` skips this.

Variables: `SHIBAOX_HOME` (default `~/.shibaox`), `SHIBAOX_SOURCE` (a git URL or a local clone), `SHIBAOX_REF` (a branch or tag, default `main`).

Then:

```sh
shibaox doctor           # what is ready, what is missing
shibaox daemon install   # keep the daemon running across logins (launchd on macOS, systemd --user on Linux)
shibaox                  # the dashboard
shibaox app              # the same, as a web page in your browser
# or the macOS app: the dmg of each release, see The app page
```

## With npm

```sh
npm i -g shibaox
```

The `shibaox` package brings the CLI, the daemon and the dashboard (`@wizardingcode/shibaox-tui`, built JavaScript that Bun runs). Update with `npm i -g shibaox@latest`, then `shibaox daemon stop` so the daemon restarts on the new build.

## In Docker (a server)

```sh
docker run -d --name shibaox --restart unless-stopped --init --stop-timeout 75 -p 7433:7433 \
  -e SHIBAOX_DAEMON_TOKEN=$(openssl rand -hex 32) \
  -v shibaox-data:/data -v /srv/projects:/projects \
  ghcr.io/wizardingcode-io/shibaox
```

The image (`Dockerfile` in the repository; built from the npm packages by GitHub Actions on every version tag, `linux/amd64` and `linux/arm64`) runs `shibaox serve` as `node` (uid 1000) with git, `gh` and Claude Code installed. `/data` is the shibaox home (runs, vault, `daemon.yaml`, the default org): use a named volume, or a host directory owned by uid 1000. Repositories bind-mounted under `/projects` must be writable by uid 1000 (`chown -R 1000 /srv/projects`); every git repository directly inside is offered to the dashboard (`projects_dir: /projects` is written to `daemon.yaml` on first start). `--stop-timeout 75` (compose: `stop_grace_period`) lets the daemon wait for active runs before the container stops; `--init` reaps the children of gates and runtimes. `docker-compose.yml` in the repository sets all of this with a `.env` holding the token. The token can also live in the vault instead of the environment: start once with the variable, `shibaox keys set SHIBAOX_DAEMON_TOKEN …` from your machine, then restart without it. Then, from your machine, `shibaox remote set http://<host>:7433 <token>`: see [Remote daemon](Remote-daemon) for the token, TLS and the Claude login inside the container.

## Linux

The installer and npm work on Linux as on macOS (Node 22, git; Bun for the dashboard). `shibaox daemon install` writes a `systemd --user` unit (`~/.config/systemd/user/shibaox.service`) and enables it now; `loginctl enable-linger $USER` keeps it running when nobody is logged in. The unit gets the user's systemd environment, not your shell's: keys belong in the vault (`shibaox keys set`).

## Upgrading

```sh
shibaox upgrade
```

For an installer checkout: pulls, installs, builds and restarts the daemon. Nothing happens when already up to date. A failed build says where the checkout is, that the daemon keeps the old build until it restarts, and how to go back. For an npm install it points you at `npm i -g shibaox@latest`.

## From a clone (development)

```sh
git clone https://github.com/WizardingCode-io/shibaox.git && cd shibaox
pnpm install && pnpm build && pnpm test
node apps/cli/dist/index.js --help
```

`SHIBAOX_SOURCE=/path/to/shibaox sh scripts/install.sh` installs from that clone instead of GitHub. See [Development](Development).

## If `better-sqlite3` fails to build

Prebuilt binaries exist for common platforms. Without one you need a C/C++ toolchain (macOS: `xcode-select --install`), then:

```sh
npm i -g node-gyp
cd ~/.shibaox/app && pnpm rebuild better-sqlite3
```

More in [Troubleshooting](Troubleshooting).
