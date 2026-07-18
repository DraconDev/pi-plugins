/**
 * pi-chrome-auto-auth
 *
 * Auto-authorizes pi-chrome for the lifetime of each Pi session by setting
 * the persistent auth state that pi-chrome's extension factory reads on init.
 *
 * Mechanism (mirrors pi-chrome source lines 686-693 of
 * extensions/chrome-profile-bridge/index.ts):
 *   - pi-chrome's factory reads `globalThis["__piChromeProfileBridgeAuth__"]`
 *     and assigns `{ until: ... }` to its module-local `chromeAuthorizedUntil`.
 *   - We pre-set that key to `{ until: "indefinite" }` so the chrome_* tools
 *     are usable immediately on every Pi startup, with no 15-min timeout.
 *
 * Cold-start race fix:
 *   pi-chrome's own `session_start` handler calls `activateChromeTools()`
 *   which does `pi.setActiveTools([...CHROME_TOOL_NAMES])`. That call is
 *   async (`await bridge.start()` happens first inside the same handler) and
 *   on a cold startup it can race with the first agent turn — the result is
 *   that the chrome_* tools appear in the registered tool list but NOT in
 *   the active tool list, so the model can't call them until the user does
 *   /reload (which re-fires session_start with reason "reload" and the timing
 *   works out cleanly).
 *
 *   We close the race by:
 *     1. Listening for `agent_start` (fires AFTER session_start has settled
 *        and BEFORE the model sees the tool list for the upcoming turn).
 *     2. Checking whether any chrome_* tool name is already active.
 *     3. If not, and the persistent auth is still good, force-adding the full
 *        chrome_* tool set via `pi.setActiveTools`.
 *
 *   This is a belt-and-suspenders fix that doesn't require patching pi-chrome:
 *   if pi-chrome's session_start handler wins the race, we do nothing. If it
 *   loses, we patch the active-tool list before the first turn. Either way
 *   the user gets chrome_* tools on the first prompt of a cold session.
 *
 * Load-order requirement: this extension must load before pi-chrome. When
 * installed as a pi package via `pi install /path/to/this` it is registered
 * in the `packages` array of ~/.pi/agent/settings.json. Pi loads user-local
 * extension entries from `extensions` first, then `packages`. If you ever
 * see "Chrome control locked" after /reload, list this package FIRST in
 * `packages` (or move it to `extensions`), and reload.
 *
 * Security note: this makes every new Pi session in this user account able
 * to drive your real signed-in Chrome without an explicit /chrome authorize.
 * The 127.0.0.1 loopback bridge and the Chrome companion extension are still
 * required for any tool call, and `/chrome revoke` still works to lock tools
 * mid-session (the lock holds until the next /reload or Pi exit; the next
 * fresh Pi startup re-asserts the indefinite auth).
 *
 * To temporarily turn it off for a session:
 *   - `/chrome revoke` to lock until next /reload, OR
 *   - comment out the `g[PI_CHROME_AUTH_KEY] = ...` line and `/reload`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const ANNOUNCED_KEY = "__piChromeAutoAuthAnnounced__";

// Mirror pi-chrome's own tool-name list (see
// extensions/chrome-profile-bridge/index.ts ~line 641). Keep in sync if
// pi-chrome adds new tools; we use a prefix match so new chrome_* tools
// (e.g. chrome_print, chrome_tap) are picked up automatically without
// editing this file.
const CHROME_TOOL_PREFIX = "chrome_";

const isChromeTool = (name: string): boolean => name.startsWith(CHROME_TOOL_PREFIX);

const hasChromeToolActive = (tools: readonly string[]): boolean =>
	tools.some(isChromeTool);

const authStillValid = (g: Record<string | symbol, unknown>): boolean => {
	const persisted = g[PI_CHROME_AUTH_KEY] as
		| { until?: number | "indefinite" }
		| undefined;
	if (!persisted || persisted.until === undefined) return false;
	if (persisted.until === "indefinite") return true;
	return typeof persisted.until === "number" && persisted.until > Date.now();
};

export default function (pi: ExtensionAPI): void {
	const g = globalThis as Record<string | symbol, unknown>;

	// Pre-set the persistent auth state. pi-chrome's factory reads this on
	// init and assigns it to its module-local `chromeAuthorizedUntil`.
	g[PI_CHROME_AUTH_KEY] = { until: "indefinite" };

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;

		// Re-assert on every fresh Pi startup in case anything cleared it.
		g[PI_CHROME_AUTH_KEY] = { until: "indefinite" };

		// One-time startup notice so the user can see the extension is active.
		// globalThis is process-lifetime, so the flag survives /reload.
		if (!g[ANNOUNCED_KEY]) {
			g[ANNOUNCED_KEY] = true;
			ctx.ui.notify("pi-chrome auto-authenticated (indefinite)", "info");
		}
	});

	// Cold-start race safety net. agent_start fires after session_start has
	// had a chance to settle (pi-chrome's own session_start handler is async
	// because of `await bridge.start()`), but before the model sees the tool
	// list for the upcoming turn. If pi-chrome's activateChromeTools() won
	// the race, chrome_* tools are already active and we do nothing. If it
	// lost, we re-add them here so the first prompt of a cold session gets
	// the chrome tools without requiring /reload.
	pi.on("agent_start", () => {
		if (!authStillValid(g)) return;

		const active = pi.getActiveTools();
		if (hasChromeToolActive(active)) return;

		// pi-chrome owns the canonical list of chrome_* tool names. We
		// re-add it via setActiveTools but only by reading what's already
		// registered through pi.getAllTools(), so we never invent a name
		// that doesn't exist.
		const all = pi.getAllTools();
		const chromeTools = all.filter((t) => isChromeTool(t.name)).map((t) => t.name);
		if (chromeTools.length === 0) return;

		const merged = [...new Set([...active, ...chromeTools])];
		pi.setActiveTools(merged);
	});
}
