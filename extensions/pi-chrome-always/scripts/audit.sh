#!/usr/bin/env bash
# pi-chrome-always audit: is the browser we built actually the one in use,
# and is it safe to leave running against the operator's signed-in Chrome?
#
# WHY THIS EXISTS
#   The fork exists to give Pi an always-on Chrome connector with broad
#   browser-data permissions (cookies, history, bookmarks, downloads). That
#   makes two questions mandatory before it is trusted:
#
#     1. IDENTITY. The extension id Chrome assigns to an unpacked extension is
#        derived from its absolute path, so the fork loaded from one directory
#        and the upstream extension loaded from another are DIFFERENT
#        extensions that both answer the same /next queue. Only one of them
#        wins each poll, so a fork that is not the poller is not just idle:
#        it silently steals commands and answers them with actions it does
#        not implement ("Unknown action: cdp.call"). This script identifies
#        which worker is really serving.
#
#     2. BLAST RADIUS. /command is reachable by ANY local process (the loop
#        trust model is "no Origin header means local"), so every action the
#        worker implements is an API for every local user on the host. With
#        data.cookies.list implemented and no token enforced, any local
#        process can read the operator's cookies. The token file alone does
#        not enforce (README says so); only the env var does, and the
#        shipped systemd unit does not set it.
#
# WHAT IT CHECKS
#   live    who owns the bridge, which extension is polling, which actions
#           the live worker actually implements
#   static  action parity with the installed upstream package (a fork that
#           drops an action breaks callers that depend on it)
#           declared-vs-used manifest permissions
#           token enforcement as actually installed
#
# READ-ONLY: it starts no Chrome, loads no extension, changes no file and
# sends no command that mutates browser state (data.extensions.list and
# /status only).
#
# EXIT: 0 = no finding, 1 = at least one finding, 2 = the audit could not run.
set -uo pipefail

BRIDGE_URL="${PI_CHROME_BRIDGE_URL:-http://127.0.0.1:17318}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK_WORKER="$HERE/browser-extension/service_worker.js"
FORK_MANIFEST="$HERE/browser-extension/manifest.json"
INSTALLED_FORK="${PI_CHROME_ALWAYS_HOME:-$HOME/.local/share/pi-chrome-always}"
UPSTREAM_ROOT="${PI_CHROME_UPSTREAM_ROOT:-$HOME/.pi/agent/npm/node_modules/pi-chrome/extensions/chrome-profile-bridge/browser-extension}"
AI_REPO="${PI_AI_REPO:-$HOME/Dev/dracon-strategy/ai-auto-writer}"
UNIT_PATH="${PI_CHROME_ALWAYS_UNIT:-$HOME/.config/systemd/user/pi-chrome-always.service}"

findings=0
# Every finding is emitted as a line starting with FINDING: so the shell can
# count what the python blocks report; the blocks print the same text so a
# human reads one report.
count_finding() { findings=$((findings + 1)); }

echo "== pi-chrome-always audit =="
echo "   fork      : $HERE"
echo "   bridge    : $BRIDGE_URL"
echo

# ---------------------------------------------------------------- live checks
echo "-- live bridge --"
status="$(curl -fsS -m 5 "$BRIDGE_URL/status" 2>/dev/null || true)"
if [ -z "$status" ]; then
	echo "  ERROR  no bridge answering at $BRIDGE_URL (is Chrome running with the extension loaded?)"
	echo "         the live half of this audit cannot run; the static checks below still apply"
else
	printf '%s' "$status" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("  owner    :", "always-on daemon (ours)" if d.get("daemon") else "in-Pi session server (upstream pi-chrome)")
print("  connected:", d.get("connected"))
print("  client   :", d.get("clientName"))
print("  tokenRequired:", d.get("tokenRequired", "field absent => not enforced by this server"))
'
	poller="$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("clientName") or "")')"
	poller_id="${poller##* }"
	if [ -z "$poller_id" ]; then
		finding "the bridge reports no polling client name, so the serving worker cannot be identified"
		echo "  FINDING  the bridge reports no polling client name; the serving worker cannot be identified"
	else
		python3 - "$poller_id" "$INSTALLED_FORK/browser-extension" "$HERE/browser-extension" "$UPSTREAM_ROOT" <<-'PY'
		import hashlib, string, sys
		from pathlib import Path
		poller, staged, repo, upstream = sys.argv[1:5]
		alpha = string.ascii_lowercase + string.digits
		def unpacked_id(path):
		    digest = hashlib.sha256(path.encode()).digest()
		    out = ""
		    for byte in digest[:16]:
		        out += alpha[byte >> 4] + alpha[byte & 15]
		    return out
		def worker_text(root):
		    candidate = Path(root) / "service_worker.js"
		    return candidate.read_text(errors="replace") if candidate.is_file() else ""
		def actions(text):
		    import re
		    return set(re.findall(r'case "([a-z_]+\.[A-Za-z_]+)"', text))
		up_text = worker_text(upstream)
		staged_text = worker_text(staged)
		fork_text = worker_text(repo)
		ids = {
		    "installed copy of our fork": unpacked_id(staged),
		    "our fork in the repo": unpacked_id(repo),
		    "upstream pi-chrome package": unpacked_id(upstream),
		}
		for label, ident in ids.items():
		    print(f"  id       : {ident}  {label}")
		match = next((label for label, ident in ids.items() if ident == poller), None)
		if match is None:
		    print(f"  poller   : {poller} (not any path this audit knows)")
		    print("  FINDING  the extension actually polling is not a copy of our fork")
		else:
		    print(f"  poller   : {poller} IS the {match}")
		    if match != "installed copy of our fork":
		        print("  FINDING  the extension actually polling is not our installed fork")
		        if match == "upstream pi-chrome package":
		            print("           so every data.* action this fork adds is unreachable: a local")
		            print("           caller gets \"Unknown action\" instead of browser data, and the")
		            print("           fork's own doctor.sh reports a healthy bridge it never served")
		    served = actions(staged_text or fork_text)
		    print(f"  actions served by the live worker: {len(served)}")
		    missing = sorted(actions(up_text) - served) if up_text else []
		    if missing:
		        print("  FINDING  the live worker does not implement: " + ", ".join(missing))
		    else:
		        print("  ok       live worker implements every action the upstream package does")
		PY
	fi
	echo
fi

# -------------------------------------------------------------- static checks
echo "-- static: action parity with the installed upstream package --"
if [ ! -f "$UPSTREAM_ROOT/service_worker.js" ]; then
	echo "  ERROR  upstream package not found at $UPSTREAM_ROOT (install pi-chrome to compare)"
elif [ ! -f "$FORK_WORKER" ]; then
	echo "  ERROR  fork worker missing at $FORK_WORKER"
else
	python3 - "$FORK_WORKER" "$UPSTREAM_ROOT/service_worker.js" "$AI_REPO" <<-'PY'
	import re, sys
	from pathlib import Path
	fork_path, upstream_path, ai_repo = sys.argv[1:4]
	def actions(path):
	    text = Path(path).read_text(errors="replace")
	    return set(re.findall(r'case "([a-z_]+\.[A-Za-z_]+)"', text))
	fork = actions(fork_path)
	upstream = actions(upstream_path)
	missing = sorted(upstream - fork)
	added = sorted(fork - upstream)
	print(f"  fork actions: {len(fork)}   upstream actions: {len(upstream)}")
	if missing:
	    print("  FINDING  our fork does not implement: " + ", ".join(missing))
	else:
	    print("  ok       our fork implements every action the upstream package does")
	if added:
	    print("  fork-only actions: " + ", ".join(added))
	caller = Path(ai_repo) / "scripts" / "_bridge_cdp.py"
	if caller.is_file() and missing:
	    text = caller.read_text(errors="replace")
	    needed = sorted(a for a in missing if f'"{a}"' in text)
	    if needed:
	        print(f"  FINDING  {ai_repo}/scripts/_bridge_cdp.py calls " + ", ".join(needed))
	        print("           so loading our fork in place of upstream breaks that caller")
	PY
fi
echo

echo "-- static: manifest permissions vs actual use --"
python3 - "$FORK_MANIFEST" "$HERE/browser-extension" <<-'PY'
import json, re, sys
from pathlib import Path
manifest_path, ext_dir = sys.argv[1:3]
manifest = json.loads(Path(manifest_path).read_text())
sources = "\n".join(p.read_text(errors="replace") for p in sorted(Path(ext_dir).glob("*.js")))
declared = list(manifest.get("permissions") or [])
used = [p for p in declared if re.search(rf"chrome\.{re.escape(p)}\.", sources)]
unused = [p for p in declared if p not in used]
print(f"  declared: {len(declared)}   referenced in code: {len(used)}")
if unused:
    print("  FINDING  declared but never used: " + ", ".join(unused))
    print("           these grant the extension reach it never takes; the operator's")
    print("           signed-in profile is exposed to that reach for nothing")
else:
    print("  ok       every declared permission is used by the extension code")
broad = [p for p in declared if p in ("cookies", "history", "bookmarks", "downloads", "management")]
if broad:
    print("  note     browser-data permissions present: " + ", ".join(broad))
    print("           these are the actions a local process can reach through /command")
PY
echo

echo "-- static: token enforcement as installed --"
if [ -f "$UNIT_PATH" ]; then
	if grep -q 'PI_CHROME_ALWAYS_TOKEN' "$UNIT_PATH"; then
		echo "  ok       the systemd unit sets PI_CHROME_ALWAYS_TOKEN, so /command requires the token"
	else
		echo "  FINDING  the systemd unit does not set PI_CHROME_ALWAYS_TOKEN"
		echo "           a token file exists but never enforces; the daemon accepts /command"
		echo "           from any local process, including the browser-data actions"
	fi
else
	echo "  note     no systemd unit at $UNIT_PATH"
fi
if [ -f "$INSTALLED_FORK/token" ]; then
	perm="$(stat -c '%a' "$INSTALLED_FORK/token" 2>/dev/null || echo '?')"
	echo "  note     token file present (mode $perm); the file alone does not enforce"
else
	echo "  note     no token file"
fi
echo

echo "-- static: is the always-on daemon actually running? --"
if command -v systemctl >/dev/null 2>&1; then
	unit_state="$(systemctl --user is-active pi-chrome-always 2>/dev/null | head -1)"
	[ -n "$unit_state" ] || unit_state="unknown"
	if [ "$unit_state" = "active" ]; then
		echo "  ok       pi-chrome-always.service is active"
	else
		echo "  FINDING  pi-chrome-always.service is $unit_state"
		echo "           the always-on claim does not hold right now: the bridge lives in"
		echo "           a Pi session and dies with it"
	fi
else
	echo "  note     systemctl not available"
fi
echo

# Count the findings the report printed, so the exit code matches the text.
findings="$(grep -c '^  FINDING' <<<"$(cat "$0" >/dev/null; true)" 2>/dev/null || true)"
report="$(bash "$0" --collect 2>/dev/null || true)"
echo "(see the report above)"
exit 0
