# Codenotch for GNOME

A black notch welded to the right edge of the screen that shows, at a glance,
how much of each coding assistant's usage limit you have burned. A GNOME Shell
port of [vinzdg/codenotch](https://github.com/vinzdg/codenotch) (macOS,
Swift), keeping its geometry, palette and motion.

At rest it is a thin pill on the screen edge. Hover it and it unfolds into a
stack of provider rings; hover a ring and a card slides out with every limit
window, when each resets, and the Claude Code sessions running right now.
Spinning arcs inside a ring mean that tool is working; a pulsing ring means it
is waiting on you.

## Providers

Codenotch never signs in anywhere. Every reading is borrowed from a credential
a tool on this machine already holds, and a provider only gets a cell when that
credential exists.

| Provider | Credential read | Usage endpoint |
|----------|-----------------|----------------|
| Claude Code | `~/.claude/.credentials.json` | `api.anthropic.com/api/oauth/usage` |
| Codex CLI | `~/.codex/auth.json` | `chatgpt.com/backend-api/wham/usage` |

Tokens are read only, never refreshed or written. If one expires, the card
says so and the tool itself refreshes it on its next run.

## Install

```sh
ln -s "$PWD/codenotch@rick" ~/.local/share/gnome-shell/extensions/codenotch@rick
gnome-extensions enable codenotch@rick
```

On Wayland the shell only discovers new extension directories at login, so
the first enable may need a log out and back in. Later edits also need a
re-login (or `Alt+F2`, `r` on X11).

Requires GNOME Shell 48 or newer.

## Preferences

Open them from the Extensions app or with `gnome-extensions prefs codenotch@rick`.

- **Posição**: which screen edge the notch is welded to (right, left, top,
  bottom) and where along that edge it sits. A top notch hangs below the
  panel; a bottom one rests on the dock.
- **Aparência**: body colour, body opacity, overall size, and whether the
  percent label shows under each ring. Rings, glyphs and text never change.
- **Comportamento**: keep the notch always unfolded, hide it while a window
  is fullscreen, and how often usage is read.

Every change rebuilds the surface in place; nothing needs a restart.

## Development

`dev/nested.sh` runs a headless GNOME Shell with only this extension enabled
and has the extension photograph itself at rest, unfolded, and with each
provider's card open. Screenshots land in `dev/out/`. Settings can be
injected as keyfile lines; `dev/prefs-shot.sh` opens the preferences window
inside that shell and photographs it too.

```sh
./dev/nested.sh
NESTED_SETTINGS=$'edge=\'top\'\nopacity=0.7' ./dev/nested.sh dev/out-top
./dev/prefs-shot.sh
```

The schema in `schemas/` must be compiled after editing:
`glib-compile-schemas codenotch@rick/schemas/`.

Layout constants live in `layout.js` and are the design frame's measurements
scaled so the ring is 44 px; change nothing there without a ruler.

## Not ported (yet)

- Cursor, Grok, GLM, OpenCode and Antigravity providers.
- The settings orb; preferences live in a normal GNOME preferences window.
- Codex session activity (it lives in a SQLite file).
