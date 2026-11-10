/**
 * Device-code sign-in for the MiniMax account.
 *
 * The Matrix connector API accepts a bearer token from the public OAuth
 * client `mcode-public`. When that credential is missing or has been revoked,
 * a fresh one can be obtained without installing or running MCode: the OAuth
 * device-code flow at account.minimax.io.
 *
 * The resulting credential is written into the same store MCode uses
 * (~/.minimax/auth/<env>/<region>/mcode-public/auth.json) in MCode's exact
 * format, so the extension and MCode end up sharing one login.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CredentialStore, MatrixAuthError, writeJsonAtomic } from "./matrix-client";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface LoginFlow {
  id: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  deviceCode: string;
  codeVerifier: string;
  expiresAtMs: number;
  intervalSec: number;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Ask the OAuth server for a device code the user can approve in a browser. */
export async function startLogin(store: CredentialStore): Promise<LoginFlow> {
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const body = new URLSearchParams({
    client_id: "mcode-public",
    scope: "agent.default",
    audience: "agent-backend",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  let res: Response;
  try {
    res = await fetch(`${store.accountBaseUrl}/oauth2/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: any) {
    throw new MatrixAuthError(`Could not reach ${store.accountBaseUrl}/oauth2/device/code: ${err?.message ?? err}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new MatrixAuthError(`Device sign-in request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MatrixAuthError("Device sign-in returned a non-JSON response.");
  }

  const deviceCode = parsed?.device_code;
  const userCode = parsed?.user_code;
  const verificationUri = parsed?.verification_uri;
  if (!deviceCode || !userCode || !verificationUri) {
    throw new MatrixAuthError("Device sign-in returned an incomplete response.");
  }

  const expiresInSec = Number(parsed.expires_in ?? 300);
  return {
    id: randomUUID(),
    userCode,
    verificationUri,
    verificationUriComplete: parsed?.verification_uri_complete ?? `${verificationUri}?user_code=${userCode}`,
    deviceCode,
    codeVerifier,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    intervalSec: Number(parsed.interval ?? 5),
  };
}

/** Poll the token endpoint until the user approves (or the flow expires). */
export async function completeLogin(
  store: CredentialStore,
  flow: LoginFlow,
  timeoutMs = 240_000,
): Promise<{ accessToken: string; expiresAtMs: number }> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = Math.max(1, flow.intervalSec) * 1000;

  while (Date.now() < deadline) {
    if (Date.now() > flow.expiresAtMs) {
      throw new MatrixAuthError("The device sign-in expired before it was approved. Start a new one.");
    }

    const body = new URLSearchParams({
      grant_type: DEVICE_CODE_GRANT,
      device_code: flow.deviceCode,
      client_id: "mcode-public",
      code_verifier: flow.codeVerifier,
    });

    const res = await fetch(`${store.accountBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();

    let parsed: any = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the raw text for the error below */
    }

    const pending =
      parsed?.status === "pending" ||
      parsed?.status === "slow_down" ||
      parsed?.error === "authorization_pending" ||
      parsed?.error === "slow_down";

    if (pending) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (!res.ok) {
      throw new MatrixAuthError(
        `Device sign-in failed (HTTP ${res.status}): ${parsed?.error_description ?? parsed?.error ?? text.slice(0, 300)}`,
      );
    }
    if (typeof parsed?.access_token !== "string" || !parsed.access_token) {
      throw new MatrixAuthError("Device sign-in returned no access_token.");
    }
    return {
      accessToken: parsed.access_token,
      expiresAtMs: Date.now() + Number(parsed.expires_in ?? 3600) * 1000,
    };
  }

  throw new MatrixAuthError("Device sign-in was not approved in time. Start a new one.");
}

/**
 * Write a fresh credential into the store in MCode's on-disk format.
 * MCode reads the same file, so this is a single shared login.
 */
export function writeCredential(
  store: CredentialStore,
  tokens: { accessToken: string; refreshToken: string; expiresAtMs: number },
): void {
  // The credential key hash is derived from <dataDir>/auth, the namespace home.
  const authHome = join(store.dir, "..", "..", "..");
  const key = `com.minimax.mcode.oauth.${store.buildEnv}.${store.region}\0${base64url(
    createHash("sha256").update(`${authHome}\0mcode-public`).digest(),
  )}`;

  let doc: any = { schemaVersion: 1, records: {} };
  if (existsSync(store.authFile)) {
    try {
      const existing = JSON.parse(readFileSync(store.authFile, "utf8"));
      if (existing && typeof existing === "object" && existing.records) doc = existing;
    } catch {
      /* start from a clean document */
    }
  }
  if (!doc.records || typeof doc.records !== "object") doc.records = {};

  const previous = doc.records[key];
  const generation = (previous?.generation ?? 0) + 1;

  doc.schemaVersion = 1;
  doc.records[key] = {
    schemaVersion: 1,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: "Bearer",
    clientId: "mcode-public",
    scopes: ["agent.default"],
    audience: "agent-backend",
    expiresAtMs: tokens.expiresAtMs,
    generation,
    loginEpoch: randomUUID(),
  };

  writeJsonAtomic(store.authFile, doc);

  writeJsonAtomic(store.stateFile, {
    schemaVersion: 2,
    status: "authenticated",
    storeKind: "file",
    clientId: "mcode-public",
    scopes: ["agent.default"],
    audience: "agent-backend",
    buildEnv: store.buildEnv,
    region: store.region,
    generation,
    expiresAtMs: tokens.expiresAtMs,
  });
}
