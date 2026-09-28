#!/bin/sh
# shibaox installer: one checkout under ~/.shibaox/app, one `shibaox` on your PATH.
#   curl -fsSL https://raw.githubusercontent.com/wizardingcode/shibaox/main/scripts/install.sh | sh
# Variables: SHIBAOX_HOME (default ~/.shibaox), SHIBAOX_SOURCE (git URL or local path of the
# repository), SHIBAOX_REF (branch or tag, default main), SHIBAOX_NO_PROFILE=1 (do not touch
# ~/.zprofile).
set -eu

HOME_DIR="${SHIBAOX_HOME:-$HOME/.shibaox}"
APP="$HOME_DIR/app"
BIN="$HOME_DIR/bin"
SOURCE="${SHIBAOX_SOURCE:-https://github.com/wizardingcode/shibaox.git}"
REF="${SHIBAOX_REF:-main}"

say() { printf '%s\n' "$*"; }
fail() { say "shibaox install: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have git || fail "git is required (https://git-scm.com)"
have node || fail "Node.js 22 or later is required (https://nodejs.org, nvm, or brew install node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js $NODE_MAJOR found; 22 or later is required"
if ! have pnpm; then
  if have corepack; then
    say "enabling pnpm through corepack"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
  fi
  have pnpm || fail "pnpm is required: npm i -g pnpm (or corepack enable)"
fi
have bun || say "note: Bun is not installed; the dashboard (shibaox) needs it: https://bun.sh (the CLI and the daemon work without it)"

mkdir -p "$HOME_DIR" "$BIN"
chmod 700 "$HOME_DIR"
if [ -d "$APP/.git" ]; then
  say "updating $APP ($REF)"
  git -C "$APP" fetch -q origin
  git -C "$APP" checkout -q "$REF"
  git -C "$APP" pull -q --ff-only origin "$REF" || true
else
  say "cloning $SOURCE into $APP ($REF)"
  git clone -q --branch "$REF" "$SOURCE" "$APP"
fi

say "installing dependencies and building (a few minutes the first time)"
(cd "$APP" && pnpm install --frozen-lockfile --silent && pnpm build >/dev/null)

cat > "$BIN/shibaox" <<'LAUNCHER'
#!/bin/sh
# shibaox launcher, written by scripts/install.sh: the CLI from the app checkout, on the
# node of your shell.
APP="${SHIBAOX_APP:-${SHIBAOX_HOME:-$HOME/.shibaox}/app}"
exec node "$APP/apps/cli/dist/index.js" "$@"
LAUNCHER
chmod 755 "$BIN/shibaox"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    if [ "${SHIBAOX_NO_PROFILE:-}" = "1" ]; then
      say "add to your PATH: export PATH=\"$BIN:\$PATH\""
    else
      PROFILE="$HOME/.zprofile"
      LINE="export PATH=\"$BIN:\$PATH\""
      if [ -f "$PROFILE" ] && grep -Fq "$BIN" "$PROFILE"; then :; else
        printf '\n# shibaox\n%s\n' "$LINE" >> "$PROFILE"
        say "added $BIN to PATH in $PROFILE (a login shell reads it; run: $LINE for this one)"
      fi
    fi
    ;;
esac

say ""
say "shibaox installed: $BIN/shibaox ($(node "$APP/apps/cli/dist/index.js" --version 2>/dev/null || echo unknown))"
say "next: shibaox doctor · shibaox daemon install (keeps it running) · shibaox (the dashboard)"
