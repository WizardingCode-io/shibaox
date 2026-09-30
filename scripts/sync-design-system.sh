#!/usr/bin/env bash
# Copies the parts of the Shibaox design system the browser app ships into apps/app/vendor/design-system.
# Source of truth: the design system checkout (default ~/Projects/shibaox/design-system).
set -euo pipefail
SRC="${1:-$HOME/Projects/shibaox/design-system}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/apps/app/vendor/design-system"
[ -f "$SRC/tokens.css" ] || { echo "no design system at $SRC (tokens.css missing)" >&2; exit 1; }
mkdir -p "$DEST/components" "$DEST/fonts" "$DEST/logos" "$DEST/app-icon"
cp "$SRC/tokens.css" "$DEST/tokens.css"
cp "$SRC/components/bundle.css" "$SRC/components/bundle.js" "$SRC/components/index.d.ts" "$DEST/components/"
cp "$SRC"/fonts/*.woff2 "$DEST/fonts/"
cp "$SRC"/assets/Logos/*.svg "$DEST/logos/" 2>/dev/null || true
cp "$SRC"/assets/AppIcon/*.svg "$SRC"/assets/AppIcon/*-180.png "$SRC"/assets/AppIcon/*-512.png "$DEST/app-icon/" 2>/dev/null || true
printf 'Synced from %s on %s\n' "$SRC" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DEST/SYNCED.txt"
echo "design system synced into $DEST"
