#!/usr/bin/env bash
#
# apply.sh — re-apply this forked pi-mempalace extension into pi's runtime.
#
# pi loads the extension from the npm-installed package directory. After any
# `pi` update/reinstall that may overwrite it with the upstream npm version,
# run this to restore the fork. Reuses the already-built native better-sqlite3
# in the shared node_modules (no rebuild needed).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$REPO_DIR/extensions/pi-mempalace"
DEST="$HOME/.pi/agent/npm/node_modules/pi-mempalace/extensions/pi-mempalace"

if [ ! -d "$DEST" ]; then
  echo "✗ Runtime pi-mempalace not found at:"
  echo "    $DEST"
  echo "  Is 'npm:pi-mempalace' still listed in ~/.pi/agent/settings.json packages?"
  exit 1
fi

cp -v "$SRC/index.ts"        "$DEST/index.ts"
cp -v "$SRC/memory_store.ts" "$DEST/memory_store.ts"

echo "✓ Applied forked pi-mempalace to runtime. Restart pi to load the changes."
