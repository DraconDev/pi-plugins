#!/usr/bin/env bash
#
# pack-to-crx.sh <extension-path>
#
# Packs an unpacked Chrome extension into a .crx file using google-chrome-stable.
# Output path is <extension-path>.crx in the parent directory.
#
# Returns:
#   0  - CRX written; prints absolute path on stdout
#   1  - usage / path / manifest error
#   2  - no Chrome/Chromium binary found
#   3  - chrome --pack-extension failed

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <extension-path>" >&2
  exit 1
fi

EXT_PATH="$1"
EXT_PATH="$(cd "$EXT_PATH" 2>/dev/null && pwd || echo "$EXT_PATH")"

if [ ! -f "$EXT_PATH/manifest.json" ]; then
  echo "no manifest.json in: $EXT_PATH" >&2
  exit 1
fi

# Find a Chrome binary. Prefer google-chrome-stable on NixOS.
CHROME_BIN=""
for cand in google-chrome-stable google-chrome chrome chromium; do
  if command -v "$cand" >/dev/null 2>&1; then
    CHROME_BIN="$(command -v "$cand")"
    break
  fi
done

# NixOS profile bins
for cand in /etc/profiles/per-user/dracon/bin/google-chrome-stable \
            /run/current-system/sw/bin/google-chrome-stable \
            /run/current-system/sw/bin/chromium; do
  if [ -x "$cand" ]; then
    CHROME_BIN="$cand"
    break
  fi
done

if [ -z "$CHROME_BIN" ]; then
  echo "no google-chrome-stable / chromium binary found" >&2
  exit 2
fi

OUT_DIR="$(dirname "$EXT_PATH")"
OUT_BASE="$(basename "$EXT_PATH")"

# --pack-extension writes <name>.crx and <name>.pem in the cwd.
# We use a temp cwd so the .crx ends up where we expect.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# --no-sandbox is required when running as root in some containerized envs.
# It is safe to pass on a normal user session.
"$CHROME_BIN" --pack-extension="$EXT_PATH" --no-sandbox >/dev/null 2>&1 || {
  echo "chrome --pack-extension failed for: $EXT_PATH" >&2
  exit 3
}

if [ ! -f "$OUT_BASE.crx" ]; then
  echo "expected $OUT_BASE.crx was not written" >&2
  exit 3
fi

mv "$OUT_BASE.crx" "$OUT_DIR/$OUT_BASE.crx"
# Move the .pem too in case the user wants a stable key for re-packing.
if [ -f "$OUT_BASE.pem" ]; then
  mv "$OUT_BASE.pem" "$OUT_DIR/$OUT_BASE.pem"
fi

echo "$OUT_DIR/$OUT_BASE.crx"
