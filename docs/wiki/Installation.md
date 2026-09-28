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
shibaox daemon install   # macOS: keep the daemon running across logins
shibaox                  # the dashboard
```

## With npm

```sh
npm i -g shibaox
```

The `shibaox` package brings the CLI, the daemon and the dashboard (`@wizardingcode/shibaox-tui`, built JavaScript that Bun runs). Update with `npm i -g shibaox@latest`, then `shibaox daemon stop` so the daemon restarts on the new build.

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
