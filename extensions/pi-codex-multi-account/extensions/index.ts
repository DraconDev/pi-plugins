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

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// --- ChatGPT OAuth constants (public client id, not a secret) ---

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const BASE_URL = "https://chatgpt.com/backend-api";
const API = "openai-codex-responses";
const CALLBACK_PORT = 1455;
const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface AccountSpec {
	id: string;
	label: string;
}

interface Credential {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
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

// --- JWT helpers (read-only, never logs token material) ---

function decodeJwt(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function accountIdFromToken(token: string): string | undefined {
	const claims = decodeJwt(token);
	const auth = claims?.[JWT_CLAIM_PATH] as { chatgpt_account_id?: string } | undefined;
	return typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
}

function identityFromToken(token: string): { email?: string; plan?: string } {
	const claims = decodeJwt(token);
	const auth = claims?.[JWT_CLAIM_PATH] as { chatgpt_plan_type?: string } | undefined;
	const profile = claims?.["https://api.openai.com/profile"] as { email?: string } | undefined;
	const email = typeof profile?.email === "string" ? profile.email : undefined;
	const plan = typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined;
	return { email, plan };
}

// --- OAuth flow ---

function pkce() {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<Credential> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
		signal,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI token request failed (${response.status})${text ? `: ${text}` : ""}`);
	}
	const json = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error("OpenAI token response missing fields.");
	}
	const access = json.access_token;
	const credential: Credential = {
		type: "oauth",
		access,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
	const accountId = accountIdFromToken(access);
	if (accountId) credential.accountId = accountId;
	return credential;
}

function parseAuthInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		/* not a URL */
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.includes("#") ? value.slice(value.indexOf("#") + 1) : value);
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	return { code: value };
}

async function startCallbackServer(state: string): Promise<{ server: Server; code: Promise<string> }> {
	let settle!: (code: string) => void;
	let reject!: (error: Error) => void;
	const code = new Promise<string>((res, rej) => {
		settle = res;
		reject = rej;
	});
	void code.catch(() => undefined);
	let consumed = false;
	const server = createServer((request, response) => {
		if (request.method !== "GET" || consumed) {
			response.writeHead(400).end("Invalid OAuth callback.");
			return;
		}
		try {
			const url = new URL(request.url ?? "/", REDIRECT_URI);
			if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
				response.writeHead(400).end("Invalid OAuth callback.");
				return;
			}
			const value = url.searchParams.get("code");
			if (!value) {
				response.writeHead(400).end("Missing code.");
				return;
			}
			consumed = true;
			response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Login completed. You can close this window.");
			settle(value);
		} catch {
			response.writeHead(400).end("Invalid OAuth callback.");
		}
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 15_000;
	await new Promise<void>((res, rej) => {
		server.once("error", rej);
		server.listen(CALLBACK_PORT, "127.0.0.1", () => res());
	});
	return { server, code };
}

async function loginBrowser(
	callbacks: {
		notify: (info: { type: string; [key: string]: unknown }) => void;
		prompt: (prompt: { type: string; [key: string]: unknown }) => Promise<string>;
		signal?: AbortSignal;
	},
): Promise<Credential> {
	const { verifier, challenge } = pkce();
	const state = randomBytes(16).toString("hex");
	const url = new URL(AUTHORIZE_URL);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator: "pi",
	}).toString();

	let callback: { server: Server; code: Promise<string> } | undefined;
	try {
		callback = await startCallbackServer(state);
	} catch {
		// Port 1455 busy (Codex CLI running): fall back to pasting the redirect URL.
	}

	callbacks.notify({
		type: "auth_url",
		url: url.href,
		instructions: callback
			? "Sign in with the ChatGPT account for this slot. The browser will finish the login automatically."
			: "Sign in with ChatGPT, then paste the full redirect URL back here.",
	});

	const manual = callbacks
		.prompt({
			type: "manual_code",
			message: callback ? "Paste the full redirect URL if the browser did not finish:" : "Paste the full redirect URL:",
			placeholder: REDIRECT_URI,
		})
		.then(input => parseAuthInput(input));

	let code: string | undefined;
	if (callback) {
		try {
			code = await Promise.race([callback.code, manual.then(parsed => parsed.code)]);
		} finally {
			callback.server.close();
			callback.server.closeAllConnections();
		}
	} else {
		const parsed = await manual;
		code = parsed.code;
	}
	if (!code) throw new Error("Login did not return an authorization code.");
	return tokenRequest(
		new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: REDIRECT_URI,
		}),
		callbacks.signal,
	);
}

async function loginDeviceCode(
	callbacks: {
		notify: (info: { type: string; [key: string]: unknown }) => void;
		prompt: (prompt: { type: string; [key: string]: unknown }) => Promise<string>;
		signal?: AbortSignal;
	},
): Promise<Credential> {
	const response = await fetch(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal: callbacks.signal,
	});
	if (!response.ok) {
		throw new Error(`Device code request failed (${response.status}).`);
	}
	const started = (await response.json()) as { device_auth_id?: string; user_code?: string; interval?: number | string };
	const intervalSeconds = typeof started.interval === "string" ? Number(started.interval) : started.interval;
	if (!started.device_auth_id || !started.user_code || typeof intervalSeconds !== "number") {
		throw new Error("Invalid device code response.");
	}
	callbacks.notify({
		type: "device_code",
		userCode: started.user_code,
		verificationUri: DEVICE_VERIFICATION_URI,
		intervalSeconds,
		expiresInSeconds: 15 * 60,
	});

	const deadline = Date.now() + 15 * 60_000;
	let wait = Math.max(intervalSeconds, 1) * 1000;
	while (Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, wait));
		const poll = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ device_auth_id: started.device_auth_id, user_code: started.user_code }),
			signal: callbacks.signal,
		});
		if (poll.ok) {
			const json = (await poll.json()) as { authorization_code?: string; code_verifier?: string };
			if (!json.authorization_code || !json.code_verifier) throw new Error("Invalid device auth response.");
			return tokenRequest(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: CLIENT_ID,
					code: json.authorization_code,
					code_verifier: json.code_verifier,
					redirect_uri: DEVICE_REDIRECT_URI,
				}),
				callbacks.signal,
			);
		}
		const body = await poll.text().catch(() => "");
		if (body.includes("slow_down")) {
			wait += 5_000;
			continue;
		}
		if (poll.status === 403 || poll.status === 404 || body.includes("deviceauth_authorization_pending")) continue;
		throw new Error(`Device login failed (${poll.status}).`);
	}
	throw new Error("Device login timed out.");
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
				login: async (callbacks: {
					notify: (info: { type: string; [key: string]: unknown }) => void;
					prompt: (prompt: { type: string; [key: string]: unknown }) => Promise<string>;
					signal?: AbortSignal;
				}) => {
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
				refreshToken: async (credential: Credential, signal?: AbortSignal) =>
					tokenRequest(
						new URLSearchParams({
							grant_type: "refresh_token",
							client_id: CLIENT_ID,
							refresh_token: credential.refresh,
						}),
						signal,
					),
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
				lines.push(`${account.id.padEnd(14)} ${status.padEnd(14)} ${account.label}${detail ? `  ${detail}` : ""}`);
			}
			ctx.ui.notify(lines.join("\n"));
		},
	});
}
