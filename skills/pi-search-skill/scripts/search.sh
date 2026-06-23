#!/usr/bin/env bash
# pi-search-skill helper — talks to the local search-daemon.
# Usage: search.sh "query" [--max-results N] [--json] [--raw]
#
# Env: PI_SEARCH_DAEMON_URL  default http://127.0.0.1:8765
set -euo pipefail

DAEMON_URL="${PI_SEARCH_DAEMON_URL:-http://127.0.0.1:8765}"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 \"query\" [--max-results N] [--json] [--raw]" >&2
  exit 2
fi

QUERY="$1"
shift

MAX_RESULTS=8
MODE="text"  # text | json | raw
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-results) MAX_RESULTS="$2"; shift 2 ;;
    --json) MODE="json"; shift ;;
    --raw) MODE="raw"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# url-encode the query with python.
ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$QUERY")
URL="${DAEMON_URL}/search?q=${ENCODED}&max_results=${MAX_RESULTS}"

# 5-second timeout; fail fast with a clear hint if the daemon is down.
RESP=$(curl -fsS --max-time 5 "$URL" 2>&1) || {
  echo "search-daemon unreachable at $DAEMON_URL" >&2
  echo "hint: cd /home/dracon/Dev/search-daemon && ./target/release/search-daemon &" >&2
  echo "      docker compose -f deploy/compose.yaml up -d" >&2
  exit 1
}

case "$MODE" in
  raw)  printf '%s\n' "$RESP" ;;
  json) printf '%s\n' "$RESP" | python3 -m json.tool ;;
  text) HELPER_DIR="$(dirname "$0")"; export QUERY; printf '%s\n' "$RESP" | python3 "$HELPER_DIR/format_results.py" ;;
esac
