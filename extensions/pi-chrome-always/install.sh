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
mkdir -p "$INSTALL_DIR/browser-extension"
cp "$SRC_DIR/browser-extension/manifest.json" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/service_worker.js" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/snapshot_injected.js" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/offscreen.html" "$INSTALL_DIR/browser-extension/"
cp "$SRC_DIR/browser-extension/offscreen.js" "$INSTALL_DIR/browser-extension/"
echo "✓ daemon + extension staged at $INSTALL_DIR"
echo "  (Load unpacked expects: $INSTALL_DIR/browser-extension)"

# Token: generate only if missing (0600). Daemon reads it only when
# PI_CHROME_ALWAYS_TOKEN is set or PI_CHROME_ALWAYS_ENFORCE_TOKEN=1; the
# Pi extension sends X-Pi-Chrome-Token when the file exists. Default
# pi-chrome client mode sends no token, so token enforcement is OPT-IN:
# unset by default to avoid breaking upstream clients.
TOKEN_FILE="${HOME}/.local/share/pi-chrome-always/token"
if [ ! -f "$TOKEN_FILE" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '\n' > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  echo "✓ generated token: $TOKEN_FILE (0600)"
else
  echo "• token exists: $TOKEN_FILE (left untouched)"
fi
echo "  NOTE: token file alone does not enforce. To require it, set in the"
echo "  systemd unit: Environment=PI_CHROME_ALWAYS_TOKEN=<value from token file> (not printed)"
echo "  (value redacted; edit the unit + daemon restart). Upstream pi-chrome"
echo "  clients do not send the token, so enforcing breaks them — see README."

# systemd unit
cp "$SERVICE_SRC" "$SERVICE_DST"
echo "✓ systemd unit: $SERVICE_DST"
systemctl --user daemon-reload
systemctl --user enable --now pi-chrome-always || true
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
echo "   - (remove/untick the old upstream 'Pi Chrome Connector' to avoid polling conflicts)"
echo
echo "3. Verify:"
echo "   curl -s http://127.0.0.1:17318/status"
echo "   systemctl --user status pi-chrome-always --no-pager"
echo "   In Pi: /chrome-always doctor   (and /chrome doctor)"
echo
echo "4. (Optional) Chrome autostart: enable Chrome 'Continue where you left off'"
echo "   or add com.google.Chrome to your session autostart — this package"
echo "   cannot start Chrome for you (Chrome must be running to host the extension)."
