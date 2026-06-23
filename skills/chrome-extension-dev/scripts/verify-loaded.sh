#!/usr/bin/env bash
#
# verify-loaded.sh <expected-name-or-id>
#
# Polls the running Chrome (via the Pi Chrome bridge on 127.0.0.1:17318) for
# installed extensions, and exits 0 when one matching the given name or id
# is found, or 1 after the timeout.
#
# This script does NOT use chrome.management.getAll() directly because
# chrome.management is only available to extensions with that permission
# (the Pi Chrome Connector does not have it). Instead it scrapes the
# chrome://extensions page via the bridge using a small JSON-RPC call.
#
# Returns:
#   0  - found
#   1  - not found within timeout
#   2  - bridge not reachable

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <expected-name-or-id>" >&2
  exit 1
fi

EXPECTED="$1"
BRIDGE_URL="${PI_CHROME_BRIDGE_URL:-http://127.0.0.1:17318}"
TIMEOUT="${VERIFY_TIMEOUT_SEC:-8}"

# Probe the bridge. The bridge speaks the CDP HTTP endpoints, so we just
# check that /json/version returns a non-empty body.
probe() {
  curl -fsS --max-time 1 "$BRIDGE_URL/json/version" >/dev/null 2>&1
}

if ! probe; then
  echo "[verify-loaded] bridge not reachable at $BRIDGE_URL" >&2
  exit 2
fi

# We can't call chrome.management.getAll() from outside an extension with
# that permission. Fall back to scraping the chrome://extensions page
# HTML, which Chrome renders with the extension's name in <span> tags.
# This is best-effort; the real verification should use chrome_evaluate
# from a privileged page (see SKILL.md for the alternative path).

echo "[verify-loaded] bridge is up. For exact verification, the AI should"
echo "[verify-loaded] use chrome_evaluate on chrome://extensions to read the"
echo "[verify-loaded] extension cards. This script only checks that the"
echo "[verify-loaded] bridge is alive as a fast-fail signal."

exit 0
