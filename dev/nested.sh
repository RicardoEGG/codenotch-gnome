#!/bin/bash
# Runs a headless GNOME Shell with only this extension enabled and lets the
# extension photograph itself at rest, unfolded and with the card open.
# Usage: dev/nested.sh [output-dir]
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/dev/out}
mkdir -p "$OUT/data/gnome-shell/extensions" "$OUT/config/glib-2.0/settings"
ln -sfn "$ROOT/codenotch@rick" "$OUT/data/gnome-shell/extensions/codenotch@rick"
cat > "$OUT/config/glib-2.0/settings/keyfile" <<KEYS
[org/gnome/shell]
enabled-extensions=['codenotch@rick']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'
KEYS
rm -f "$OUT"/shot-*.png
export XDG_DATA_HOME="$OUT/data" XDG_CONFIG_HOME="$OUT/config" GSETTINGS_BACKEND=keyfile
export CODENOTCH_SHOT="$OUT/shot"
timeout "${NESTED_TIMEOUT:-20}" dbus-run-session -- \
    gnome-shell --headless --virtual-monitor "${NESTED_SIZE:-1600x900}" \
    > "$OUT/shell.log" 2>&1 || true
grep -iE "codenotch|JS ERROR|extension" "$OUT/shell.log" | grep -viE "dash-to-dock" | head -60
ls -la "$OUT"/shot-*.png 2>/dev/null || echo "no screenshots"
