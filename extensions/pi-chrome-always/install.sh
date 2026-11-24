#!/usr/bin/env bash
# pi-chrome-always install: daemon + systemd + token + extension staging.
# Idempotent. Does NOT reload Pi or Chrome for you.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/share/pi-chrome-always"
SERVICE_SRC="${SRC_DIR}/pi-chrome-always.service"
SERVICE_DST="${HOME}/.config/systemd/user/pi-chrome-always.service"

echo "== pi-chrome-always install =="
echo "src:  $SRC_DIR"
echo "dst:  $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
mkdir -p "${HOME}/.config/systemd/user"

cp "$SRC_DIR/daemon.mjs" "$INSTALL_DIR/daemon.mjs"
cp "$SRC_DIR/package.json" "$INSTALL_DIR/package.json"
mkdir -p "$INSTALL_DIR/browser-extension/icons"
cp "$SRC_DIR/browser-extension/manifest.json" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/service_worker.js" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/snapshot_injected.js" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/offscreen.html" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/offscreen.js" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR"/browser-extension/icons/* "$INSTALL_DIR/browser-extension/icons/" 2>/dev/null || true
echo "✓ daemon + extension staged at $INSTALL_DIR"
echo "  (Load unpacked expects: $INSTALL_DIR/browser-extension)"

# The manifest pins an extension id via its "key" field, so the fork has the
# SAME id no matter which directory it is loaded from. That is what makes the
# fork identifiable in chrome://extensions and in the bridge's /status, and it
# is what stops "which worker is really serving" from being unanswerable.
FORK_EXT_ID=""
if [ -f "$INSTALL_DIR/browser-extension/manifest.json" ]; then
  FORK_EXT_ID="$(python3 - "$INSTALL_DIR/browser-extension/manifest.json" <<'PY'
import base64, hashlib, json, sys
manifest = json.load(open(sys.argv[1]))
key = manifest.get("key")
if not key:
    print("")
    raise SystemExit(0)
digest = hashlib.sha256(base64.b64decode(key)).digest()
alphabet = "abcdefghijklmnop"
print("".join(alphabet[b >> 4] + alphabet[b & 15] for b in digest[:16]))
PY
)"
fi
if [ -n "$FORK_EXT_ID" ]; then
	echo "✓ fork extension id (pinned by the manifest key): $FORK_EXT_ID"
	echo "  In chrome://extensions the fork's card shows that id; upstream's card"
	echo "  shows a different one. Only ONE of them should be enabled."
fi

# Token: generate only if missing (0600). The daemon reads this file, so the
# browser-data actions (data.cookies.*, data.history.*, data.downloads.*,
# data.bookmarks.*, data.extensions.*) always require X-Pi-Chrome-Token.
# Ordinary actions keep upstream's loopback-trust model.
TOKEN_FILE="${HOME}/.local/share/pi-chrome-always/token"
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  echo "✓ generated token: $TOKEN_FILE (0600)"
else
  echo "• token exists: $TOKEN_FILE (left untouched)"
fi
echo "  The daemon enforces this token for the data.* actions only."
echo "  To require it for EVERY action, set PI_CHROME_ALWAYS_REQUIRE_TOKEN=1"
echo "  in the systemd unit (that breaks upstream pi-chrome clients)."

# systemd unit
cp "$SERVICE_SRC" "$SERVICE_DST"
echo "✓ systemd unit: $SERVICE_DST"
# The user manager can be busy with an unrelated long-running job, which makes
# daemon-reload/enable take a very long time. Bound them so an install never
# appears to hang; the daemon itself keeps retrying for the port either way.
timeout 60 systemctl --user daemon-reload || echo "  (daemon-reload slow or timed out; continuing)"
timeout 60 systemctl --user enable --now pi-chrome-always || echo "  (enable --now slow or timed out; continuing)"
echo "✓ systemctl --user enable --now pi-chrome-always"

echo
echo "== next steps (in order) =="
echo "1. In Pi:  pi install /home/dracon/Dev/pi-plugins/extensions/pi-chrome-always"
echo "           then: /reload"
echo "           (self-contained: uninstall npm:pi-chrome to avoid tool-name collision)"
echo
echo "2. In Chrome (your normal profile): chrome://extensions"
echo "   - enable Developer mode"
echo "   - Load unpacked → $INSTALL_DIR/browser-extension"
echo "   - DISABLE the upstream 'Pi Chrome Connector' extension."
echo "     Both extensions answer the same /next queue, so whichever polls"
echo "     first wins each command; the fork's data.* actions are unreachable"
echo "     while upstream's worker is the one serving."
if [ -n "$FORK_EXT_ID" ]; then
	echo "   - The fork's card is the one with id $FORK_EXT_ID."
fi
echo
echo "3. Verify:"
echo "   curl -s http://127.0.0.1:17318/status"
echo "   systemctl --user status pi-chrome-always --no-pager"
echo "   In Pi: /chrome-always doctor   (and /chrome doctor)"
echo "   ./scripts/audit.sh   (identity + parity + token enforcement)"
echo
echo "4. (Optional) Chrome autostart: enable Chrome 'Continue where you left off'"
echo "   or add com.google.Chrome to your session autostart — this package"
echo "   cannot start Chrome for you (Chrome must be running to host the extension)."
