/**
 * Headless ChatGPT login for one pi Codex slot.
 *
 * Usage:
 *   node scripts/login.ts <provider-id> [--device]
 *
 * Performs the same ChatGPT OAuth flow the pi extension uses, then stores the
 * credential in ~/.pi/agent/auth.json under <provider-id>. Start pi afterwards
 * (or /reload) to pick it up.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loginBrowser, loginDeviceCode, identityFromToken, type Credential } from "../src/codex-oauth.ts";

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");

async function main() {
	const args = process.argv.slice(2);
	const providerId = args.find(a => !a.startsWith("--"));
	if (!providerId) {
		console.error("usage: node scripts/login.ts <provider-id> [--device]");
		process.exit(1);
	}
	const useDevice = args.includes("--device");

	const credential: Credential = await (useDevice
		? loginDeviceCode({
			notify: info => {
				if (info.type === "device_code") {
					console.log(`Open this URL: ${info.verificationUri}`);
					console.log(`Enter code: ${info.userCode}`);
				}
			},
			prompt: async () => {
				throw new Error("Device login does not need manual input.");
			},
		})
		: loginBrowser({
			notify: info => {
				if (info.type === "auth_url") console.log(`\nOpen this URL to sign in:\n${info.url}\n`);
			},
			prompt: async () => {
				// Fallback when the browser callback does not arrive: read one line from stdin.
				return await new Promise<string>(resolve => {
					const onData = (chunk: Buffer) => {
						process.stdin.off("data", onData);
						resolve(chunk.toString("utf8"));
					};
					process.stdin.on("data", onData);
					process.stdin.resume();
					console.log("Or paste the full redirect URL here and press Enter:");
				});
			},
		}));

	const auth = existsSync(AUTH_PATH) ? (JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, unknown>) : {};
	auth[providerId] = {
		type: "oauth",
		access: credential.access,
		refresh: credential.refresh,
		expires: credential.expires,
		...(credential.accountId ? { accountId: credential.accountId } : {}),
	};
	writeFileSync(AUTH_PATH, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });

	const { email, plan } = identityFromToken(credential.access);
	console.log(`Logged in ${providerId}: ${email ?? "unknown email"} (plan: ${plan ?? "unknown"})`);
	console.log(`accountId: ${credential.accountId ?? "unknown"}`);
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
