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
			ctx.ui.notify(lines.join("\n"));
		},
	});
}
