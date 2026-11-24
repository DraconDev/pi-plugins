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
print(f" token auth: {'on' if s.get('tokenRequired') else 'off (loopback trust)'}  gated: {s.get('tokenGatedActions','-')}")
clients = s.get("pollingClients")
if isinstance(clients, list) and clients:
    print(f" polling extensions ({len(clients)}):")
    for c in clients:
        print(f"   - {c.get('name')}")
    if len(clients) > 1:
        print("   WARNING: more than one extension is polling the same /next queue.")
        print("   Each command goes to whichever polls first, so a data.* action can be")
        print("   answered by a worker that does not implement it. Disable one of them.")
client = s.get("clientName") or ""
if client and not client.startswith("Pi Chrome Always"):
    print("   NOTE: the serving worker is NOT this fork (fork announces 'Pi Chrome Always ...').")
    print("   The fork's browser-data actions (data.*) are unreachable while it is the poller.")
    print("   Load the fork unpacked and disable upstream's connector (see install.sh).")
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
  python3 -c "
import base64, hashlib, json
m = json.load(open('$EXT_DIR/manifest.json'))
print(f\"   name={m.get('name')} v{m.get('version')}\")
print(f\"   permissions={', '.join(m.get('permissions', []))}\")
print(f\"   host_permissions={', '.join(m.get('host_permissions', []))}\")
key = m.get('key')
if key:
    d = hashlib.sha256(base64.b64decode(key)).digest()
    a = 'abcdefghijklmnop'
    eid = ''.join(a[b >> 4] + a[b & 15] for b in d[:16])
    print(f\"   pinned extension id: {eid}\")
    print('   (the manifest key pins this id, so it is the same from every install path)')
"
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
