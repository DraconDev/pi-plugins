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
}
