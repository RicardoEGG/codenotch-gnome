#!/bin/bash
# Asks the running shell to reload the extension's code (everything except
# extension.js and prefs.js) by bumping the key the loader listens to.
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -n "$(git -C "$ROOT" status --porcelain -- codenotch@rick 2>/dev/null)" ]; then
    echo "warning: working tree has uncommitted changes; the shell will load them as they are" >&2
fi
GSETTINGS_SCHEMA_DIR="$ROOT/codenotch@rick/schemas" \
    gsettings set org.gnome.shell.extensions.codenotch reload-token "$(date +%s)"
