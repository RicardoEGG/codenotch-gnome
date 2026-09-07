#!/bin/bash
# Installs (or updates) a real copy of the extension into the user's GNOME
# extensions directory, so the checkout can be moved or deleted afterwards.
# Re-run after pulling changes, then reload from the preferences window.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=codenotch-gnome
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
if [ -L "$DEST" ]; then
    rm "$DEST"
fi
mkdir -p "$DEST"
rsync -a --delete --exclude 'dev/' "$ROOT/$UUID/" "$DEST/"
glib-compile-schemas "$DEST/schemas/"
if ! gsettings get org.gnome.shell enabled-extensions | grep -q "'$UUID'"; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
fi
echo "installed to $DEST"
