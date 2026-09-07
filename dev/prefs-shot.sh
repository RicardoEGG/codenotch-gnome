#!/bin/bash
# Opens the preferences window inside the headless shell and photographs it.
# GTK connects to the nested compositor's own Wayland socket, so the window
# renders there and the extension's late screenshot catches it.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(realpath -m "${1:-$ROOT/dev/out-prefs}")
mkdir -p "$OUT/data/gnome-shell/extensions" "$OUT/config/glib-2.0/settings"
ln -sfn "$ROOT/codenotch-gnome" "$OUT/data/gnome-shell/extensions/codenotch-gnome"
printf "[org/gnome/shell]\nenabled-extensions=['codenotch-gnome']\nwelcome-dialog-last-shown-version='999'\n" \
    > "$OUT/config/glib-2.0/settings/keyfile"
rm -f "$OUT"/shot-*.png
rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gnome-shell-disable-extensions"
export XDG_DATA_HOME="$OUT/data" XDG_CONFIG_HOME="$OUT/config" GSETTINGS_BACKEND=keyfile
export CODENOTCH_SHOT="$OUT/shot" CODENOTCH_SHOT_LATE=6000
unset JOURNAL_STREAM
timeout 30 dbus-run-session -- sh -c '
    gnome-shell --headless --virtual-monitor 1600x900 > "'"$OUT"'/shell.log" 2>&1 &
    sleep 9
    gnome-extensions prefs codenotch-gnome > "'"$OUT"'/prefs.log" 2>&1 || true
    wait' || true
grep -iE "codenotch|JS ERROR|Error" "$OUT/shell.log" "$OUT/prefs.log" | grep -viE "fonts|shot " | head -20
ls "$OUT"/shot-late.png 2>/dev/null || echo "no late screenshot"
