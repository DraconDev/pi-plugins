#!/usr/bin/env bash
#
# find-extension-id.sh <extension-path>
#
# Best-effort: computes the Chrome extension ID for a given extension folder
# by looking for an explicit "key" in manifest.json. If no key is present
# (the common case for unpacked dev extensions), prints a placeholder and
# a hint to look up the ID via chrome.management.getAll() in the running
# Chrome.
#
# Returns:
#   0  - prints ID (real or placeholder) and a one-line reason
#   1  - usage / path error

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <extension-path>" >&2
  exit 1
fi

EXT_PATH="$1"

if [ ! -f "$EXT_PATH/manifest.json" ]; then
  echo "no manifest.json in: $EXT_PATH" >&2
  exit 1
fi

# The "key" field in manifest.json is base64-encoded DER of the public key
# (SubjectPublicKeyInfo, 650 bytes for RSA 2048). The extension ID is
# computed by Chrome as the first 32 hex chars of a SHA-256 of the
# UTF-8 byte string: <key-as-base64> + the path. We can't reproduce the
# path component reliably from outside Chrome, so we delegate to the
# running Chrome via chrome.management.getAll() for the real ID.
#
# What we CAN do: if "key" is present, we know the public key. If it's
# missing, the ID is purely a hash of the absolute path on disk + key,
# which only Chrome knows.

if command -v jq >/dev/null 2>&1; then
  KEY_B64="$(jq -r '.key // empty' "$EXT_PATH/manifest.json" 2>/dev/null || true)"
else
  KEY_B64="$(grep -oE '"key"[[:space:]]*:[[:space:]]*"[^"]+"' "$EXT_PATH/manifest.json" \
              | head -1 | sed -E 's/.*"([A-Za-z0-9+/=]+)".*/\1/' || true)"
fi

if [ -z "$KEY_B64" ]; then
  echo "UNKNOWN:no-key-in-manifest"
  echo "hint: get the real ID by running in Chrome devtools console on any page:" >&2
  echo "  chrome.management.getAll().then(es => es.filter(e => e.installType==='development').map(e => e.id))" >&2
  exit 0
fi

# We have a key. Print it so the caller can pass it to Chrome via initScript
# or compute the ID with a real Chrome once.
echo "KEY:$KEY_B64"
echo "hint: this is the base64 public key. Chrome computes the ID as" >&2
echo "  sha256(absolute_path + key)[:16].hex" >&2
echo "  Run chrome.management.getAll() in Chrome to get the live ID." >&2
