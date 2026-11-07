#!/usr/bin/env bash
# pi-chrome-always doctor: bridge + daemon + extension + permissions check.
set -euo pipefail
BRIDGE_URL="${PI_CHROME_BRIDGE_URL:-http://127.0.0.1:17318}"
echo "== pi-chrome-always doctor =="
echo "bridge: $BRIDGE_URL"

if curl -fsS -m 3 "$BRIDGE_URL/status" > /tmp/pi-chrome-always-status.json 2>/dev/null; then
  cat /tmp/pi-chrome-always-status.json; echo
  python3 - <<'PY'
import json
try:
    s = json.load(open("/tmp/pi-chrome-always-status.json"))
except Exception as e:
    print(f"Invalid status JSON: {e}"); raise SystemExit(0)
print(f" daemon: {s.get('daemon','?')} v{s.get('bridgeVersion','?')} (upstream {s.get('upstreamPiChromeVersion','?')})")
print(f" connected: {s.get('connected')} client: {s.get('clientName','-')}")
print(f" token auth: {'on' if s.get('tokenRequired') else 'off (loopback trust)'}")
PY
else
  echo "✗ no bridge listening at $BRIDGE_URL"
  echo "  → systemctl --user start pi-chrome-always   (or ./install.sh)"
  echo "  → systemctl --user status pi-chrome-always --no-pager"
  echo "  → journalctl --user -u pi-chrome-always --no-pager | tail -20"
fi

echo
echo "== daemon (systemd) =="
systemctl --user is-active pi-chrome-always 2>/dev/null || echo "not active (Pi sessions can still open their own bridge on 17318)"
systemctl --user is-enabled pi-chrome-always 2>/dev/null || echo "not enabled"

echo
echo "== extension fork =="
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/browser-extension"
if [ -f "$EXT_DIR/manifest.json" ]; then
  echo "✓ $EXT_DIR/manifest.json present"
  python3 -c "import json; m=json.load(open('$EXT_DIR/manifest.json')); print(f\"   name={m.get('name')} v{m.get('version')}\"); print(f\"   permissions={', '.join(m.get('permissions', []))}\"); print(f\"   host_permissions={', '.join(m.get('host_permissions', []))}\")"
else
  echo "✗ missing $EXT_DIR/manifest.json"
fi

echo
echo "== chrome (best effort) =="
if command -v google-chrome-stable >/dev/null 2>&1; then
  echo "✓ google-chrome-stable found"
elif command -v chromium >/dev/null 2>&1; then
  echo "✓ chromium found"
else
  echo "⚠ no chrome/chromium on PATH"
fi

echo
echo "Limits: no control while Chrome closed; no chrome:// pages, native dialogs, password-manager, CAPTCHA/passkeys."
