/**
 * pi-chrome-always
 *
 * Always-on browser bridge for Pi (systemd daemon + indefinite auth + broad
 * Chrome permissions). Pairs with:
 *   - npm:pi-chrome (upstream chrome_* tools, kept as the tab/input layer)
 *   - ./daemon.mjs (standalone loopback bridge, runs under systemd)
 *   - ./browser-extension/ (fork with cookies/bookmarks/history/downloads/
 *     management + offscreen keepalive; version drift tolerated)
 *
 * What this Pi extension does:
 *   1. Indefinite auto-auth (same mechanism as pi-chrome-auto-auth):
 *      pre-sets globalThis["__piChromeProfileBridgeAuth__"] = {until:"indefinite"}
 *      so pi-chrome starts authorized with no /chrome authorize prompt.
 *      Cold-start race fix on agent_start (force-adds chrome_* tools).
 *   2. Daemon assurance: on session_start, GET /status on 127.0.0.1:17318;
 *      if unreachable, runs `systemctl --user start pi-chrome-always`
 *      and re-checks. Never spawns the daemon itself (avoids double-bind
 *      races); systemd is the single owner.
 *   3. New data tool `chrome_always_data` for the broad-permissions actions
 *      (data.*) that upstream pi-chrome does not expose: cookies,
 *      bookmarks, history, downloads, extensions. These POST directly to
 *      the loopback bridge /command (same protocol as pi-chrome client mode).
 *   4. /chrome-always command: status / doctor / daemon start|stop|restart /
 *      background info.
 *
 * Background/focus policy (user choice: background default):
 *   Upstream pi-chrome defaults `backgroundDefault = true` (module-local,
 *   not settable from here). We keep it that way and surface it in
 *   /chrome-always status. Use `/chrome background off` to watch Chrome.
 *
 * Honest limits: no browser control is possible while Chrome is closed,
 * and chrome:// pages, native dialogs, password-manager prompts, CAPTCHA /
 * passkeys remain out of reach (Chrome sandbox boundaries). See README.md.
 *
 * Load order: this extension must load BEFORE pi-chrome. Install first:
 *   pi install /home/dracon/Dev/pi-plugins/extensions/pi-chrome-always
 *   pi install npm:pi-chrome
 *   /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PI_CHROME_AUTH_KEY = "__piChromeProfileBridgeAuth__";
const ANNOUNCED_KEY = "__piChromeAlwaysAnnounced__";
const CHROME_TOOL_PREFIX = "chrome_";
const BRIDGE_HOST = process.env.PI_CHROME_BRIDGE_HOST ?? "127.0.0.1";
const BRIDGE_PORT = Number(process.env.PI_CHROME_BRIDGE_PORT ?? "17318");
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
const ALWAYS_EXT_DIR =
	typeof __dirname === "string" ? __dirname
		: typeof import.meta !== "undefined" && (import.meta as { url?: string }).url
			? join(process.cwd(), ".")
			: process.cwd();
const ALWAYS_MANIFEST = join(ALWAYS_EXT_DIR, "browser-extension", "manifest.json");
const ALWAYS_MANIFEST_CANDIDATES: Array<string> = [
	join(ALWAYS_EXT_DIR, "browser-extension", "manifest.json"),
	join(process.cwd(), "extensions/pi-chrome-always/browser-extension/manifest.json"),
	join(process.cwd(), "browser-extension/manifest.json"),
];
const alwaysManifestExists = (): boolean => ALWAYS_MANIFEST_CANDIDATES.some((p) => existsSync(p));
const TOKEN_FILE = join(process.env.HOME ?? "", ".local/share/pi-chrome-always/token");

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

function readToken(): string | undefined {
	if (process.env.PI_CHROME_ALWAYS_TOKEN) return process.env.PI_CHROME_ALWAYS_TOKEN;
	try {
		if (existsSync(TOKEN_FILE)) {
			const t = readFileSync(TOKEN_FILE, "utf8").trim();
			if (t) return t;
		}
	} catch {
		// No token file = token auth off (loopback trust, pi-chrome client compat).
	}
	return undefined;
}

async function bridgeStatus(timeoutMs = 2_000): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(`${BRIDGE_URL}/status`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return null;
		return (await res.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

async function bridgeSend(
	action: string,
	params: Record<string, unknown>,
	timeoutMs = 30_000,
): Promise<unknown> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	const token = readToken();
	if (token) headers["x-pi-chrome-token"] = token;
	const res = await fetch(`${BRIDGE_URL}/command`, {
		method: "POST",
		headers,
		body: JSON.stringify({ action, params, timeoutMs }),
		signal: AbortSignal.timeout(timeoutMs + 2_000),
	});
	const payload = (await res.json().catch(() => ({}))) as {
		ok?: boolean;
		result?: unknown;
		error?: string;
	};
	if (!res.ok || !payload.ok) {
		throw new Error(payload.error ?? `Chrome bridge HTTP ${res.status}`);
	}
	return payload.result;
}

const DATA_ACTIONS = [
	"data.cookies.list",
	"data.cookies.get",
	"data.bookmarks.tree",
	"data.history.search",
	"data.downloads.list",
	"data.extensions.list",
] as const;

export default function (pi: ExtensionAPI): void {
	const g = globalThis as Record<string | symbol, unknown>;

	// Indefinite auto-auth (before pi-chrome's factory reads it).
	g[PI_CHROME_AUTH_KEY] = { until: "indefinite" };

	async function ensureDaemon(piRef: ExtensionAPI): Promise<string> {
		const s = await bridgeStatus();
		if (s) {
			const daemon = s.daemon === "pi-chrome-always" ? "pi-chrome-always daemon" : "pi-chrome session bridge";
			const ver = s.bridgeVersion ?? "?";
			const conn = s.connected ? "extension connected" : "extension not polling yet";
			return `${daemon} v${ver} on ${String(s.url ?? BRIDGE_URL)} (${conn})`;
		}
		// Try systemd first (the always-on owner).
		try {
			await piRef.exec("systemctl", ["--user", "start", "pi-chrome-always"], {
				timeout: 5_000,
			});
			const after = await bridgeStatus(3_000);
			if (after) return `started systemd pi-chrome-always daemon (v${String(after.bridgeVersion ?? "?")})`;
		} catch {
			// Fall through to hint.
		}
		return (
			"no bridge on " + BRIDGE_URL + " — run: systemctl --user start pi-chrome-always " +
			"(or ./install.sh). Chrome extension still needs to be loaded in your profile."
		);
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		g[PI_CHROME_AUTH_KEY] = { until: "indefinite" };

		const daemonLine = await ensureDaemon(pi).catch((e) => `daemon check failed: ${(e as Error).message}`);
		const extOk = existsSync(ALWAYS_MANIFEST);
		if (!g[ANNOUNCED_KEY]) {
			g[ANNOUNCED_KEY] = true;
			ctx.ui.notify(
				`pi-chrome-always: auto-auth (indefinite) · ${daemonLine}` +
					(extOk ? "" : ` · !! extension not found at ${ALWAYS_MANIFEST}`),
				extOk ? "info" : "warning",
			);
		}
		// Re-assert chrome_* tools if pi-chrome lost the cold-start race (same as auto-auth).
		// agent_start handler below is the real fix; this is belt-and-suspenders.
		try {
			const active = pi.getActiveTools();
			if (!hasChromeToolActive(active) && authStillValid(g)) {
				const all = pi.getAllTools();
				const chromeTools = all.filter((t) => isChromeTool(t.name)).map((t) => t.name);
				if (chromeTools.length > 0) pi.setActiveTools([...new Set([...active, ...chromeTools])]);
			}
		} catch {
			// Non-fatal.
		}
	});

	pi.on("agent_start", () => {
		if (!authStillValid(g)) return;
		const active = pi.getActiveTools();
		if (hasChromeToolActive(active)) return;
		const all = pi.getAllTools();
		const chromeTools = all.filter((t) => isChromeTool(t.name)).map((t) => t.name);
		if (chromeTools.length === 0) return;
		pi.setActiveTools([...new Set([...active, ...chromeTools])]);
	});

	pi.registerCommand("chrome-always", {
		description:
			"Always-on browser bridge controls.\n" +
			"  /chrome-always status                 — daemon + extension + auth snapshot.\n" +
			"  /chrome-always doctor                 — checks daemon, extension, versions, permissions.\n" +
			"  /chrome-always daemon start|stop|restart — drive the systemd unit.\n" +
			"  /chrome-always background             — show focus policy (background default on).",
		handler: async (args, ctx) => {
			const [head, ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
			if (!head || head === "status") {
				const s = await bridgeStatus();
				if (!s) {
					ctx.ui.notify(`No bridge on ${BRIDGE_URL}. Run /chrome-always doctor for next steps.`, "warning");
					return;
				}
				ctx.ui.notify(
					`bridge ${String(s.url ?? BRIDGE_URL)} (${s.daemon === "pi-chrome-always" ? "pi-chrome-always daemon" : "pi-chrome session bridge"} v${String(s.bridgeVersion ?? "?")}) · ` +
						`${s.connected ? "extension polling" : "extension not polling"} · ` +
						`auth: indefinite (auto) · background: on (default) · client: ${String(s.clientName ?? "—")}`,
					"info",
				);
				return;
			}
			if (head === "doctor") {
				const lines: string[] = ["pi-chrome-always doctor"];
				const s = await bridgeStatus();
				if (s) {
					lines.push(`✓ Bridge ${String(s.url ?? BRIDGE_URL)} (daemon=${String(s.daemon ?? "unknown")} v${String(s.bridgeVersion ?? "?")}, upstream pi-chrome ${String(s.upstreamPiChromeVersion ?? "?")})`);
					lines.push(s.connected ? "✓ Companion extension is polling /next" : "✗ Extension not polling — load it at chrome://extensions (Developer mode → Load unpacked → browser-extension/) and keep Chrome open");
					lines.push(`auth: auto indefinite (this package) · token auth: ${s.tokenRequired ? "on (X-Pi-Chrome-Token required)" : "off (loopback trust)"}`);
				} else {
					lines.push(`✗ No bridge on ${BRIDGE_URL}`);
					lines.push("  → systemctl --user start pi-chrome-always   (or ./install.sh)");
					lines.push("  → journalctl --user -u pi-chrome-always --no-pager | tail -20");
				}
				lines.push(existsSync(ALWAYS_MANIFEST) ? "✓ Forked extension found (browser-extension/manifest.json)" : `✗ Forked extension missing at ${ALWAYS_MANIFEST}`);
				lines.push("✓ Background default: on (Chrome stays behind; use /chrome background off to watch)");
				lines.push("Limits: no control while Chrome closed; no chrome:// pages, native dialogs, password-manager, CAPTCHA/passkeys.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (head === "daemon") {
				const sub = rest[0] ?? "status";
				if (sub === "status") {
					try {
						const out = await pi.exec("systemctl", ["--user", "status", "pi-chrome-always", "--no-pager"], { timeout: 5_000 });
						ctx.ui.notify((out.stdout || String(out)).slice(0, 3000), "info");
					} catch {
						const s = await bridgeStatus();
						ctx.ui.notify(s ? `Bridge up: ${JSON.stringify(s)}` : "Bridge down and systemd unit not running. Run ./install.sh", "info");
					}
					return;
				}
				if (sub === "start" || sub === "restart") {
					await pi.exec("systemctl", ["--user", sub === "restart" ? "restart" : "start", "pi-chrome-always"], { timeout: 10_000 }).catch(() => ctx.ui.notify("systemctl start failed — check journalctl", "warning"));
					const s = await bridgeStatus();
					ctx.ui.notify(s ? `Daemon up (v${String(s.bridgeVersion ?? "?")})` : "Still no bridge — check journalctl --user -u pi-chrome-always", s ? "info" : "warning");
					return;
				}
				if (sub === "stop") {
					await pi.exec("systemctl", ["--user", "stop", "pi-chrome-always"], { timeout: 5_000 }).catch(() => undefined);
					ctx.ui.notify("Daemon stopped (Pi sessions can still open their own bridge on 17318).", "info");
					return;
				}
				ctx.ui.notify("Usage: /chrome-always daemon start|stop|restart|status", "warning");
				return;
			}
			if (head === "background") {
				ctx.ui.notify("Focus policy: background on (default). Chrome stays behind Pi. Run /chrome background off in upstream pi-chrome when you want to watch Chrome.", "info");
				return;
			}
			ctx.ui.notify(`Unknown subcommand '${head}'. Try: status | doctor | daemon start|stop|restart | background.`, "warning");
		},
	});

	pi.registerTool({
		name: "chrome_always_data",
		label: "Chrome Always Data",
		description:
			"Broad-permissions browser data via the always-on bridge (cookies, bookmarks, history, downloads, extensions). Requires the forked extension (browser-extension/) with expanded permissions + the loopback daemon on 127.0.0.1:17318. Cookies/history expose sensitive browsing data — use sparingly.",
		promptSnippet: "Query cookies/bookmarks/history/downloads/extensions via the always-on Chrome bridge.",
		parameters: Type.Object({
						ActionUnion: Type.Union(DATA_ACTIONS.map((a) => Type.Literal(a)) as [ReturnType<typeof Type.Literal>, ...ReturnType<typeof Type.Literal>[]]),
			domain: Type.Optional(Type.String({ description: "cookies.list: optional domain filter." })),
			name: Type.Optional(Type.String({ description: "cookies.list/cookies.get: optional cookie name filter." })),
			url: Type.Optional(Type.String({ description: "cookies.get: full URL of the cookie." })),
			storeId: Type.Optional(Type.String({ description: "cookies.list/cookies.get: optional cookie store id." })),
			text: Type.Optional(Type.String({ description: "history.search: query text (empty = recent)." })),
			maxResults: Type.Optional(Type.Number({ description: "history.search / downloads.list: max results (default 50)." })),
			limit: Type.Optional(Type.Number({ description: "downloads.list: max results (default 50)." })),
			startTime: Type.Optional(Type.Number({ description: "history.search: start time (ms since epoch, default 0 = all)." })),
		}),
		async execute(_id, params, signal): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
			if (signal?.aborted) throw new Error("Chrome command aborted");
			const { action, ...rest } = params as { action: string; [k: string]: unknown };
			const forwarded: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(rest)) {
				if (v !== undefined) forwarded[k] = v;
			}
			const result = await bridgeSend(action, forwarded, 30_000);
			const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
				details: { action, result: result as never },
			};
		},
	});
}
