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

# ------------------------------------------------------------------ findings
# The checks below print human-readable lines; every line that starts with
# "  FINDING" is a finding. The report is captured once and counted from the
# captured text, so the exit code can never disagree with the report.
REPORT=""
say() { REPORT+="$1"$'\n'; }
emit() { say "$1"; }

run_checks() {
	# ---------------------------------------------------------------- live
	say "-- live bridge --"
	local status poller poller_id
	status="$(curl -fsS -m 5 "$BRIDGE_URL/status" 2>/dev/null || true)"
	if [ -z "$status" ]; then
		emit "  ERROR  no bridge answering at $BRIDGE_URL (is Chrome running with the extension loaded?)"
		emit "         the live half of this audit cannot run; the static checks below still apply"
	else
		local live_summary
		live_summary="$(printf '%s' "$status" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("  owner    :", "always-on daemon (ours)" if d.get("daemon") else "in-Pi session server (upstream pi-chrome)")
print("  connected:", d.get("connected"))
print("  client   :", d.get("clientName"))
print("  tokenRequired:", d.get("tokenRequired", "field absent => not enforced by this server"))
clients = d.get("pollingClients")
if isinstance(clients, list):
    print("  polling  :", len(clients), "extension(s) have polled this bridge")
    for c in clients:
        print("            -", c.get("name"))
')"
		while IFS= read -r line; do emit "$line"; done <<< "$live_summary"
		# More than one extension polling the same /next queue is the fork's
		# central hazard: whichever polls first wins each command, so a fork
		# that is not the poller silently answers with actions it lacks.
		local polling_count
		polling_count="$(printf '%s' "$status" | python3 -c '
import json,sys
clients = json.load(sys.stdin).get("pollingClients")
print(len(clients) if isinstance(clients, list) else 0)
' 2>/dev/null || echo 0)"
		if [ "${polling_count:-0}" -gt 1 ]; then
			emit "  FINDING  $polling_count extensions are polling this bridge"
			emit "           they answer the same /next queue, so each command goes to whichever"
			emit "           polls first: a data.* action can be answered by a worker that does"
			emit "           not implement it (\"Unknown action\"). Disable one of them."
		fi
		poller="$(printf '%s' "$status" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("clientName") or "")')"
		poller_id="${poller##* }"
		if [ -z "$poller_id" ]; then
			emit "  FINDING  the bridge reports no polling client name, so the serving worker cannot be identified"
		else
			local identity_report
			identity_report="$(python3 - "$poller_id" "$INSTALLED_FORK/browser-extension" "$HERE/browser-extension" "$UPSTREAM_ROOT" <<-'PY'
			import base64, hashlib, json, re, string, sys
			from pathlib import Path
			poller, staged, repo, upstream = sys.argv[1:5]
			alpha = string.ascii_lowercase + string.digits
			def unpacked_id(path):
			    # Chrome derives an UNPACKED extension's id from the absolute path
			    # unless the manifest pins a "key", in which case the key wins and
			    # the id is the same from every directory. Our fork pins one, so
			    # compute the real id rather than guessing from the path.
			    manifest = Path(path) / "manifest.json"
			    try:
			        key = json.loads(manifest.read_text()).get("key")
			    except Exception:
			        key = None
			    if key:
			        digest = hashlib.sha256(base64.b64decode(key)).digest()
			        out = ""
			        for byte in digest[:16]:
			            out += alpha[byte >> 4] + alpha[byte & 15]
			        return out
			    digest = hashlib.sha256(path.encode()).digest()
			    out = ""
			    for byte in digest[:16]:
			        out += alpha[byte >> 4] + alpha[byte & 15]
			    return out
			def worker_text(root):
			    candidate = Path(root) / "service_worker.js"
			    return candidate.read_text(errors="replace") if candidate.is_file() else ""
			def actions(text):
			    return set(re.findall(r'case "([a-z_]+(?:\.[A-Za-z_]+)+)"', text))
			up_text = worker_text(upstream)
			staged_text = worker_text(staged)
			fork_text = worker_text(repo)
			ids = {
			    "installed copy of our fork": unpacked_id(staged),
			    "our fork in the repo": unpacked_id(repo),
			    "upstream pi-chrome package": unpacked_id(upstream),
			}
			# The worker that is actually answering /next is the one whose
			# extension id equals the polling client id. Its action set is
			# what a local caller can actually reach.
			served_text = {
			    "installed copy of our fork": staged_text,
			    "our fork in the repo": fork_text,
			    "upstream pi-chrome package": up_text,
			}.get(match_label := next((label for label, ident in ids.items() if ident == poller), ""), "")
			for label, ident in ids.items():
			    print(f"  id       : {ident}  {label}")
			match = match_label or None
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
			    served = actions(served_text)
			    print(f"  actions the live worker implements: {len(served)}")
			    wanted = sorted(actions(fork_text) | actions(up_text))
			    missing = sorted(set(wanted) - served)
			    if missing:
			        print("  FINDING  the live worker does not implement: " + ", ".join(missing))
			        print("           a local caller of those actions gets \"Unknown action\"")
			    else:
			        print("  ok       live worker implements every action either copy declares")
			PY
			)"
			while IFS= read -r line; do emit "$line"; done <<< "$identity_report"
		fi
		say ""
	fi

	# -------------------------------------------------------------- static
	say "-- static: action parity with the installed upstream package --"
	if [ ! -f "$UPSTREAM_ROOT/service_worker.js" ]; then
		emit "  ERROR  upstream package not found at $UPSTREAM_ROOT (install pi-chrome to compare)"
	elif [ ! -f "$FORK_WORKER" ]; then
		emit "  ERROR  fork worker missing at $FORK_WORKER"
	else
		local parity_report
		parity_report="$(python3 - "$FORK_WORKER" "$UPSTREAM_ROOT/service_worker.js" "$AI_REPO" <<-'PY'
		import re, sys
		from pathlib import Path
		fork_path, upstream_path, ai_repo = sys.argv[1:4]
		def actions(path):
		    text = Path(path).read_text(errors="replace")
		    return set(re.findall(r'case "([a-z_]+(?:\.[A-Za-z_]+)+)"', text))
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
		)"
		while IFS= read -r line; do emit "$line"; done <<< "$parity_report"
	fi
	say ""

	say "-- static: manifest permissions vs actual use --"
	local permission_report
	permission_report="$(python3 - "$FORK_MANIFEST" "$HERE/browser-extension" "$UPSTREAM_ROOT/manifest.json" <<-'PY'
	import json, re, sys
	from pathlib import Path
	manifest_path, ext_dir, upstream_manifest_path = sys.argv[1:4]
	manifest = json.loads(Path(manifest_path).read_text())
	sources = "\n".join(p.read_text(errors="replace") for p in sorted(Path(ext_dir).glob("*.js")))
	declared = list(manifest.get("permissions") or [])
	# A permission is "used" when the code calls its API. `activeTab` has no
	# chrome.activeTab.* API (it is a grant consumed implicitly by
	# chrome.scripting), so it is judged against the upstream manifest: a
	# permission upstream also declares is inherited, not something this fork
	# added on its own.
	upstream_declared = []
	try:
	    upstream_declared = list(json.loads(Path(upstream_manifest_path).read_text()).get("permissions") or [])
	except Exception:
	    pass
	def calls(permission):
	    return bool(re.search(rf"chrome\.{re.escape(permission)}\.", sources))
	unused_added = [
	    p for p in declared
	    if not calls(p) and p not in upstream_declared
	]
	print(f"  declared: {len(declared)}   upstream declares: {len(upstream_declared)}")
	if unused_added:
	    print("  FINDING  this fork declares but never uses: " + ", ".join(unused_added))
	    print("           these grant the extension reach it never takes; the operator's")
	    print("           signed-in profile is exposed to that reach for nothing")
	else:
	    print("  ok       every permission this fork adds on top of upstream is used by its code")
	broad = [p for p in declared if p in ("cookies", "history", "bookmarks", "downloads", "management")]
	if broad:
	    print("  note     browser-data permissions present: " + ", ".join(broad))
	    print("           these are the actions a local process can reach through /command")
	PY
	)"
	while IFS= read -r line; do emit "$line"; done <<< "$permission_report"
	say ""

	say "-- static: token enforcement as installed --"
	# The daemon reads the token file (0600) and REQUIRES it for the browser-data
	# actions (data.*), which reach the operator's cookies and history. Ordinary
	# actions keep upstream's loopback-trust model so an upstream pi-chrome
	# client and the book campaign's scripts/_bridge_cdp.py keep working.
	if [ -f "$INSTALLED_FORK/token" ]; then
		perm="$(stat -c '%a' "$INSTALLED_FORK/token" 2>/dev/null || echo '?')"
		if [ "$perm" = "600" ]; then
			emit "  ok       token file present (mode 600); the daemon requires it for data.* actions"
		else
			emit "  FINDING  token file mode is $perm, expected 600"
			emit "           the token is the only thing gating the browser-data actions, so it"
			emit "           must not be readable by other local users"
		fi
		if grep -q 'TOKEN_GATED_ACTION_PREFIXES' "$HERE/daemon.mjs"; then
			emit "  ok       the daemon gates the browser-data actions on the token"
		else
			emit "  FINDING  the daemon does not gate the browser-data actions on the token"
			emit "           data.cookies.list / data.history.search / data.downloads.list are"
			emit "           reachable from every local process"
		fi
	else
		emit "  FINDING  no token file at $INSTALLED_FORK/token"
		emit "           the browser-data actions are refused until install.sh generates one"
	fi
	if [ -f "$UNIT_PATH" ]; then
		if grep -q 'PI_CHROME_ALWAYS_REQUIRE_TOKEN' "$UNIT_PATH"; then
			emit "  note     the unit sets PI_CHROME_ALWAYS_REQUIRE_TOKEN (0 = data.* only, 1 = every action)"
		else
			emit "  note     the unit does not set PI_CHROME_ALWAYS_REQUIRE_TOKEN (data.* gating is the default)"
		fi
	else
		emit "  note     no systemd unit at $UNIT_PATH"
	fi
	say ""

	say "-- static: is the always-on daemon actually running? --"
	if command -v systemctl >/dev/null 2>&1; then
		unit_state="$(systemctl --user is-active pi-chrome-always 2>/dev/null | head -1)"
		[ -n "$unit_state" ] || unit_state="unknown"
		if [ "$unit_state" = "active" ]; then
			emit "  ok       pi-chrome-always.service is active"
		else
			emit "  FINDING  pi-chrome-always.service is $unit_state"
			emit "           the always-on claim does not hold right now: the bridge lives in"
			emit "           a Pi session and dies with it"
		fi
	else
		emit "  note     systemctl not available"
	fi
	say ""
}

run_checks

printf '%s' "$REPORT"
findings="$(grep -c '^  FINDING' <<<"$REPORT")"
errors="$(grep -c '^  ERROR' <<<"$REPORT")"
if [ "${findings:-0}" -gt 0 ]; then
	echo "== $findings finding(s) =="
	exit 1
fi
if [ "${errors:-0}" -gt 0 ]; then
	echo "== $errors check(s) could not run =="
	exit 2
fi
echo "== no findings =="
exit 0
