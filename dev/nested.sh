#!/bin/bash
# Runs a headless GNOME Shell with only this extension enabled and lets the
# extension photograph itself at rest, unfolded and with the card open.
#
# Usage: dev/nested.sh [output-dir]
#   NESTED_SETTINGS  extra keyfile lines for org/gnome/shell/extensions/codenotch,
#                    e.g. NESTED_SETTINGS=$'edge=\'top\'\nposition=0.3'
#   NESTED_SIZE      virtual monitor size (default 1600x900)
#   NESTED_RELOAD=1  bump reload-token 12 s in and take a late screenshot
#                    after it, to exercise the hot reload
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Absolute on purpose: GLib silently ignores a relative XDG_DATA_HOME.
OUT=$(realpath -m "${1:-$ROOT/dev/out}")
mkdir -p "$OUT/data/gnome-shell/extensions" "$OUT/config/glib-2.0/settings"
ln -sfn "$ROOT/codenotch-gnome" "$OUT/data/gnome-shell/extensions/codenotch-gnome"
cat > "$OUT/config/glib-2.0/settings/keyfile" <<KEYS
[org/gnome/shell]
enabled-extensions=['codenotch-gnome']
disable-user-extensions=false
welcome-dialog-last-shown-version='999'

[org/gnome/shell/extensions/codenotch]
${NESTED_SETTINGS:-}
KEYS
rm -f "$OUT"/shot-*.png
# A shell killed before its startup finished leaves this marker behind, and
# the next shell to start — nested or real — then boots with every extension
# disabled. Only a shell that is starting right now would miss it.
rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"
export XDG_DATA_HOME="$OUT/data" XDG_CONFIG_HOME="$OUT/config" GSETTINGS_BACKEND=keyfile
export CODENOTCH_SHOT="$OUT/shot"
# With JOURNAL_STREAM set (a shell started under systemd) GLib sends every log
# line to the journal and nothing to stderr, so the shell log would be silent.
unset JOURNAL_STREAM
if [ -n "${NESTED_RELOAD:-}" ]; then
    export CODENOTCH_SHOT_LATE=6000 GSETTINGS_SCHEMA_DIR="$ROOT/codenotch-gnome/schemas"
    # Same dbus session and same keyfile as the shell, which notices the write.
    timeout "${NESTED_TIMEOUT:-26}" dbus-run-session -- sh -c '
        gnome-shell --headless --virtual-monitor "'"${NESTED_SIZE:-1600x900}"'" > "'"$OUT"'/shell.log" 2>&1 &
        sleep 12
        gsettings set org.gnome.shell.extensions.codenotch reload-token 7
        wait' || true
else
    timeout "${NESTED_TIMEOUT:-18}" dbus-run-session -- \
        gnome-shell --headless --virtual-monitor "${NESTED_SIZE:-1600x900}" \
        > "$OUT/shell.log" 2>&1 || true
fi
grep -iE "codenotch|JS ERROR" "$OUT/shell.log" | grep -viE "dash-to-dock" | head -60
ls "$OUT"/shot-*.png 2>/dev/null || echo "no screenshots"
