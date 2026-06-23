#!/usr/bin/env bash
#
# load-via-xdotool.sh <extension-path>
#
# Drives the GTK file picker that Chrome's "Load unpacked" button opens, by
# typing the extension path and pressing Enter. Assumes:
#   - The picker is already open (the AI just clicked "Load unpacked" in Chrome).
#   - xdotool is installed and can talk to the picker via XWayland.
#   - DISPLAY is set (defaults to :0 on this host).
#
# Returns:
#   0  - path typed and Enter sent (caller should verify with chrome.management.getAll)
#   1  - usage error
#   2  - xdotool missing
#   3  - picker window did not appear within timeout
#   4  - failed to focus the picker window

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <extension-path>" >&2
  exit 1
fi

EXT_PATH="${1}"
# Resolve to absolute, no trailing slash
EXT_PATH="$(cd "$EXT_PATH" 2>/dev/null && pwd || echo "$EXT_PATH")"

if [ ! -d "$EXT_PATH" ]; then
  echo "not a directory: $EXT_PATH" >&2
  exit 1
fi

if [ ! -f "$EXT_PATH/manifest.json" ]; then
  echo "no manifest.json in: $EXT_PATH" >&2
  exit 1
fi

if ! command -v xdotool >/dev/null 2>&1; then
  echo "xdotool is required but not installed" >&2
  exit 2
fi

# Make sure we have an X display. On Wayland, XWayland listens on :0 by default.
: "${DISPLAY:=:0}"
export DISPLAY

echo "[load-via-xdotool] waiting for picker window (timeout 8s)..."
PICKER_WIN=""
for _ in $(seq 1 32); do  # 32 * 0.25s = 8s
  # Chromium's GTK picker has a class hint like 'Chromium' and a title like
  # 'Open' or 'Select folder'. Match loosely.
  PICKER_WIN="$(xdotool search --name 'Open' 2>/dev/null | head -1 || true)"
  if [ -n "$PICKER_WIN" ]; then
    # Refine: ensure it's a chooser dialog (has 'Open' or 'Select' in title)
    TITLE="$(xdotool getwindowname "$PICKER_WIN" 2>/dev/null || true)"
    if echo "$TITLE" | grep -Eqi 'open|select|choose'; then
      break
    fi
    PICKER_WIN=""
  fi
  sleep 0.25
done

if [ -z "$PICKER_WIN" ]; then
  echo "[load-via-xdotool] picker window not found" >&2
  exit 3
fi

TITLE="$(xdotool getwindowname "$PICKER_WIN" 2>/dev/null || true)"
echo "[load-via-xdotool] found picker window: $PICKER_WIN ($TITLE)"

if ! xdotool windowfocus --sync "$PICKER_WIN" 2>/dev/null; then
  echo "[load-via-xdotool] could not focus picker window" >&2
  exit 4
fi

# GTK file chooser focuses the location/name field. Clear it with Ctrl+A then
# Delete, then type the absolute path. --delay 30ms is gentler than the
# default and avoids losing characters on some setups.
echo "[load-via-xdotool] typing path: $EXT_PATH"
xdotool key ctrl+a
xdotool key Delete
xdotool type --clearmodifiers --delay 30 "$EXT_PATH"

# Give the typeahead a moment to settle
sleep 0.2

# Press Enter. Some GTK builds accept the path on Enter; others want a click
# on the "Open" button. Try Enter first, and the AI can re-run with a click
# variant if needed.
xdotool key --clearmodifiers Return

echo "[load-via-xdotool] path submitted. Verify in Chrome."
