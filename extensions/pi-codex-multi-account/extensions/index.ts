/**
 * pi-codex-multi-account
 *
 * Registers additional OpenAI Codex (ChatGPT OAuth) providers so several
 * ChatGPT accounts can be signed in at the same time and picked from the model
 * list, instead of one shared "openai-codex" slot that each /login overwrites.
 *
 * Each account gets its own provider id (codex-owner, codex-seat2, ...), so Pi
 * stores a separate credential per id in ~/.pi/agent/auth.json. Nothing is
 * shared or copied between accounts.
 *
 * /codex-accounts shows which ids are signed in and which ChatGPT account each
 * one is bound to.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loginBrowser,
	loginDeviceCode,
	refreshToken,
	identityFromToken,
	type Credential,
	type OAuthCallbacks,
} from "../src/codex-oauth.js";

const BASE_URL = "https://chatgpt.com/backend-api";
const API = "openai-codex-responses";

// Optional: the local codex-lb pool (a proxy that owns account selection).
// When it is running, "codex-pool" is one provider backed by every account in
// the pool — useful for "just use whatever has quota left" work. The per-account
// slots below stay direct (no proxy in the request path).
const POOL_BASE_URL = process.env.CODEX_LB_BASE_URL ?? "http://127.0.0.1:2455/v1";
const POOL_API = "openai-responses";
const POOL_KEY_PATHS = [
	join(homedir(), ".config", "codex-lb", "api.key"),
	join(homedir(), ".codex-lb", "api.key"),
];

function readPoolKey(): string | undefined {
	for (const path of POOL_KEY_PATHS) {
		if (!existsSync(path)) continue;
		try {
			const key = readFileSync(path, "utf8").trim();
			if (key) return key;
		} catch {
			/* ignore unreadable key file */
		}
	}
	return process.env.CODEX_LB_API_KEY?.trim() || undefined;
}

interface AccountSpec {
	id: string;
	label: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));

function readModels(): unknown[] {
	const path = join(HERE, "..", "models.json");
	return JSON.parse(readFileSync(path, "utf8")) as unknown[];
}

function readAccountSpecs(): AccountSpec[] {
	const path = join(homedir(), ".pi", "agent", "codex-multi-account.json");
	if (!existsSync(path)) {
		return [
			{ id: "codex-owner", label: "Business seat 1 (owner)" },
			{ id: "codex-seat2", label: "Business seat 2" },
			{ id: "codex-seat3", label: "Business seat 3" },
			{ id: "codex-seat4", label: "Business seat 4" },
			{ id: "codex-seat5", label: "Business seat 5" },
		];
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { accounts?: AccountSpec[] };
	const accounts = parsed.accounts?.filter(a => a.id && a.label) ?? [];
	return accounts.length > 0 ? accounts : [{ id: "codex-owner", label: "Business seat 1 (owner)" }];
}

export default function (pi: ExtensionAPI) {
	const accounts = readAccountSpecs();
	const models = readModels();

	for (const account of accounts) {
		pi.registerProvider(account.id, {
			name: `OpenAI Codex · ${account.label}`,
			baseUrl: BASE_URL,
			api: API,
			models: models as never[],
			oauth: {
				name: `OpenAI ChatGPT (${account.label})`,
				isSubscription: true,
				login: async (callbacks: OAuthCallbacks) => {
					const method = await callbacks.prompt({
						type: "select",
						message: `Sign in to ChatGPT for "${account.label}"`,
						options: [
							{ id: "browser", label: "Browser login (default)" },
							{ id: "device_code", label: "Device code login (headless)" },
						],
					});
					if (method === "device_code") return loginDeviceCode(callbacks);
					return loginBrowser(callbacks);
				},
				refreshToken: async (credential: Credential, signal?: AbortSignal) => refreshToken(credential, signal),
				getApiKey: (credential: Credential) => credential.access,
			},
		});
	}

	const poolKey = readPoolKey();
	if (poolKey) {
		// The pool speaks the standard Responses API, not the Codex-lite dialect.
		// Pi sends Codex's "additional_tools" bundle when a model declares
		// supportsAdditionalTools; codex-lb then takes the Codex-lite lane, whose
		// upstream requires parallel_tool_calls=false. Dropping the Codex-only
		// compat flags keeps pi on the plain Responses path.
		const poolModels = (models as Record<string, unknown>[]).map(model => {
			const compat = { ...((model.compat as Record<string, unknown>) ?? {}) };
			delete compat.supportsAdditionalTools;
			delete compat.supportsToolSearch;
			return { ...model, compat };
		});
		pi.registerProvider("codex-pool", {
			name: "OpenAI Codex Pool (codex-lb, all accounts)",
			baseUrl: POOL_BASE_URL,
			api: POOL_API,
			apiKey: poolKey,
			models: poolModels as never[],
		});
	}

	pi.registerCommand("codex-accounts", {
		description: "Show the ChatGPT accounts signed in to pi (Codex multi-account slots)",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const lines: string[] = [];
			const registry = ctx.modelRegistry;
			for (const account of accounts) {
				let status = "not signed in";
				let detail = "";
				try {
					const resolved = await registry.getProviderAuth(account.id);
					const token = resolved?.auth?.apiKey;
					if (token) {
						const { email, plan } = identityFromToken(token);
						status = "signed in";
						detail = [email, plan ? `plan:${plan}` : undefined].filter(Boolean).join("  ");
					}
				} catch {
					status = "not signed in";
				}
				lines.push(`${account.id.padEnd(14)} ${status.padEnd(13)} ${account.label}${detail ? `  ${detail}` : ""}`);
			}

			// Pool view (codex-lb): the accounts the Codex CLI draws from.
			try {
				const response = await fetch("http://127.0.0.1:2455/api/accounts", {
					signal: AbortSignal.timeout(3000),
				});
				const data = (await response.json()) as {
					accounts?: {
						accountId?: string;
						alias?: string | null;
						email?: string;
						status?: string;
						planType?: string;
						resetAtPrimary?: string;
						resetAtSecondary?: string;
					}[];
				};
				lines.push("", "pool (codex-lb):");
				for (const account of data.accounts ?? []) {
					lines.push(
						`  ${String(account.alias ?? account.email ?? "?").padEnd(32)} ${String(account.status ?? "?").padEnd(9)} ` +
							`plan:${String(account.planType ?? "?").padEnd(6)} ` +
							`5h→${String(account.resetAtPrimary ?? "?").slice(5, 16)} ` +
							`weekly→${String(account.resetAtSecondary ?? "?").slice(5, 16)}`,
					);
				}

				// Who actually served the most recent pooled requests.
				try {
					const logs = await fetch("http://127.0.0.1:2455/api/request-logs?limit=3", {
						signal: AbortSignal.timeout(3000),
					}).then(r => r.json()) as { requests?: { requestedAt?: string; accountId?: string; status?: string }[] };
					const byId = new Map((data.accounts ?? []).map(a => [a.accountId, a.alias ?? a.email]));
					const recent = (logs.requests ?? []).slice(0, 3);
					if (recent.length > 0) {
						lines.push("", "last served by the pool:");
						for (const request of recent) {
							lines.push(
								`  ${String(request.requestedAt ?? "").slice(11, 19)}  ` +
									`${String(byId.get(request.accountId ?? "") ?? "?").padEnd(32)} ${request.status ?? ""}`,
							);
						}
					}
				} catch {
					/* request log unavailable */
				}
			} catch {
				lines.push("", "pool (codex-lb): not reachable on 127.0.0.1:2455 — systemctl --user status codex-lb");
			}

			ctx.ui.notify(lines.join("\n"));
		},
	});

	pi.registerCommand("codex-guide", {
		description: "Cheat sheet for using the ChatGPT account pool and per-account slots",
		handler: async (_args: string, ctx: ExtensionContext) => {
			ctx.ui.notify(
				[
					"codex            run the Codex CLI via the pool (it picks the account with quota left)",
					"cxacct seat3     run codex pinned to one account, bypassing the pool",
					"cxacct pool      every account: status, plan, 5h + weekly reset times",
					"cxacct list      every account: email, plan, account id",
					"cxacct login s4  sign an account in   |   cxacct import s4  add it to the pool",
					"",
					"in pi:",
					"  /model codex-seat3/gpt-6.2-sol   pin a task to one account",
					"  /fanout <task>                   run the task on every account in parallel",
					"  /login codex-seat3               sign an account into its own slot",
					"  /codex-accounts                  slots + pool, with reset times",
					"  /codex-pool                      one provider backed by the whole pool",
					"",
					"dashboard: http://127.0.0.1:2455   full guide: GUIDE.md next to this extension",
				].join("\n"),
			);
		},
	});
}
