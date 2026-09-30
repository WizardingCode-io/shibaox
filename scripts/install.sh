#!/bin/sh
# shibaox installer: one checkout under ~/.shibaox/app, one `shibaox` on your PATH.
#   SHIBAOX_SOURCE=/path/to/shibaox sh scripts/install.sh        # from a clone (today)
#   curl -fsSL https://raw.githubusercontent.com/WizardingCode-io/shibaox/main/scripts/install.sh | sh
# Variables: SHIBAOX_HOME (default ~/.shibaox), SHIBAOX_SOURCE (git URL or local path of the
# repository), SHIBAOX_REF (branch or tag, default main), SHIBAOX_NO_PROFILE=1 (do not touch
# the shell profile).
set -eu

main() {
  HOME_DIR="${SHIBAOX_HOME:-$HOME/.shibaox}"
  APP="$HOME_DIR/app"
  BIN="$HOME_DIR/bin"
  LOG="$HOME_DIR/install.log"
  SOURCE="${SHIBAOX_SOURCE:-https://github.com/WizardingCode-io/shibaox.git}"
  REF="${SHIBAOX_REF:-main}"
  export GIT_TERMINAL_PROMPT=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  [ "$(id -u)" -ne 0 ] || fail "run the installer as your user, not root (sudo would leave root-owned files in your home)"
  have git || fail "git is required (https://git-scm.com)"
  have node || fail "Node.js 22 or later is required (https://nodejs.org, nvm, or brew install node)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR found; 22 or later is required"
  if ! have pnpm; then
    if have corepack; then
      say "enabling pnpm through corepack"
      corepack enable >/dev/null 2>&1 || true
    fi
    have pnpm || fail "pnpm is required: npm i -g pnpm"
  fi
  if have bun; then
    BUN_OK="$(bun --version | awk -F. '{ print ($1 > 1 || ($1 == 1 && $2 >= 3)) ? "yes" : "no" }')"
    [ "$BUN_OK" = "yes" ] || say "note: Bun $(bun --version) found; the dashboard needs 1.3 or later (bun upgrade)"
  else
    say "note: Bun is not installed; the dashboard (shibaox) needs it: https://bun.sh (the CLI and the daemon work without it)"
  fi

  if [ ! -d "$HOME_DIR" ]; then mkdir -p "$HOME_DIR"; chmod 700 "$HOME_DIR"; fi
  mkdir -p "$BIN"
  if [ -d "$APP/.git" ]; then
    ORIGIN="$(git -C "$APP" remote get-url origin 2>/dev/null || echo '?')"
    [ "$ORIGIN" = "$SOURCE" ] || say "note: $APP tracks $ORIGIN, not $SOURCE (remove $APP to switch)"
    say "updating $APP ($REF)"
    git -C "$APP" fetch -q origin </dev/null
    if [ -n "$(git -C "$APP" status --porcelain)" ]; then
      say "warning: $APP has local changes; keeping $(git -C "$APP" rev-parse --short HEAD) (reset with: git -C $APP reset --hard origin/$REF)"
    else
      git -C "$APP" checkout -q "$REF" </dev/null
      git -C "$APP" pull -q --ff-only origin "$REF" </dev/null ||
        say "warning: $APP has diverged from origin/$REF; keeping $(git -C "$APP" rev-parse --short HEAD) (reset with: git -C $APP reset --hard origin/$REF)"
    fi
  else
    say "cloning $SOURCE into $APP ($REF)"
    git clone -q --branch "$REF" "$SOURCE" "$APP" </dev/null
  fi

  say "installing dependencies and building (a few minutes the first time; log: $LOG)"
  : > "$LOG"
  # the desktop app (Electron) is not built here: no binary download, no electron-builder
  if ! (cd "$APP" && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile </dev/null && pnpm build --filter='!@wizardingcode/shibaox-desktop' </dev/null) >>"$LOG" 2>&1; then
    tail -40 "$LOG" >&2
    say "" >&2
    fail "install or build failed (full log: $LOG). If better-sqlite3 is the problem: xcode-select --install, then npm i -g node-gyp && (cd $APP && pnpm rebuild better-sqlite3)"
  fi

  NODE_BIN="$(command -v node)"
  MODULES="$(node -p process.versions.modules)"
  {
    printf '#!/bin/sh\n'
    printf '# shibaox launcher, written by scripts/install.sh: the CLI from the app checkout.\n'
    printf 'APP="${SHIBAOX_APP:-${SHIBAOX_HOME:-%s}/app}"\n' "$HOME_DIR"
    printf 'node=%s\n' "'$NODE_BIN'"
    printf 'modules=%s\n' "'$MODULES'"
    cat <<'LAUNCHER'
if [ ! -x "$node" ]; then node="$(command -v node 2>/dev/null)"; fi
[ -n "$node" ] || { echo "shibaox: node is not on the PATH" >&2; exit 1; }
if [ "$("$node" -p process.versions.modules 2>/dev/null)" != "$modules" ]; then
  echo "shibaox: $node is a different Node ABI than the install (native modules would fail): run shibaox upgrade, or (cd $APP && pnpm rebuild better-sqlite3)" >&2
fi
exec "$node" "$APP/apps/cli/dist/index.js" "$@"
LAUNCHER
  } > "$BIN/shibaox"
  chmod 755 "$BIN/shibaox"

  case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
      LINE="export PATH=\"$BIN:\$PATH\""
      if [ "${SHIBAOX_NO_PROFILE:-}" = "1" ]; then
        say "add to your PATH: $LINE"
      else
        PROFILE="$(profile_file)"
        if [ -f "$PROFILE" ] && grep -Fq "$BIN" "$PROFILE"; then :; else
          printf '\n# shibaox\n%s\n' "$LINE" >> "$PROFILE"
          say "added $BIN to PATH in $PROFILE (new shells see it; for this one run: $LINE)"
        fi
      fi
      ;;
  esac

  say ""
  say "shibaox installed: $BIN/shibaox ($("$NODE_BIN" "$APP/apps/cli/dist/index.js" --version 2>/dev/null || echo unknown))"
  say "next: shibaox doctor · shibaox daemon install (keeps it running) · shibaox (the dashboard)"
}

say() { printf '%s\n' "$*"; }
fail() { say "shibaox install: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
# the file the user's shell reads at login (macOS terminals open login shells; Linux ones do not)
profile_file() {
  case "$(uname -s):${SHELL##*/}" in
    Darwin:zsh) echo "$HOME/.zprofile" ;;
    Darwin:bash) echo "$HOME/.bash_profile" ;;
    *:zsh) echo "$HOME/.zshrc" ;;
    *:bash) echo "$HOME/.bashrc" ;;
    *) echo "$HOME/.profile" ;;
  esac
}

main "$@"
