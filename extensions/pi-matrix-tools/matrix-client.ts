/**
 * Direct Matrix connector client.
 *
 * The Matrix connector is reached over plain HTTPS at
 * `https://agent.minimax.io/minimax-cloud/api/v1/connectors/...`. The only
 * thing that used to force the `mcode-tools` CLI (and a running MCode host)
 * into the picture was the *auth broker*: mcode-tools itself is a shim that
 * borrows an access token from the MCode process over a unix socket, and the
 * socket only exists while MCode runs.
 *
 * That broker is unnecessary here. MCode persists its own OAuth credential to
 * disk (`~/.minimax/auth/<buildEnv>/<region>/mcode-public/auth.json`), and the
 * public OAuth endpoints accept a refresh for that credential without any host
 * process being involved. So we read the credential, refresh it when it is
 * about to expire, and write the rotated credential back — which keeps MCode
 * itself in sync, because it reads the same file.
 *
 * Flow:
 *   1. resolve the credential store for the active region
 *   2. read the persisted access token; refresh it when stale
 *   3. POST /minimax-cloud/api/v1/connectors/tools/call with a Bearer token
 *
 * Everything the image tools need (generate, enhance, background removal,
 * asset download, signed upload) is a connector tool on that one endpoint.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = "mcode-public";
const SCOPES = ["agent.default"];
const AUDIENCE = "agent-backend";

/** Refresh the credential when fewer than this many ms of validity remain. */
const MIN_TOKEN_VALIDITY_MS = 120_000;

const REGION_HOSTS: Record<string, { api: string; account: string }> = {
  en: { api: "https://agent.minimax.io", account: "https://account.minimax.io" },
  cn: { api: "https://agent.minimax.cn", account: "https://account.minimax.cn" },
};

const CONNECTOR_TOOLS_PATH = "/minimax-cloud/api/v1/connectors/connected-tools/list";
const CONNECTOR_CALL_PATH = "/minimax-cloud/api/v1/connectors/tools/call";

const CONNECTOR_LIST_TIMEOUT_MS = 30_000;
const CONNECTOR_CALL_TIMEOUT_MS = 600_000;
const ASSET_URL_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MatrixAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixAuthError";
  }
}

export class MatrixApiError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "MatrixApiError";
  }
}

// ---------------------------------------------------------------------------
// Credential store resolution
// ---------------------------------------------------------------------------

export interface CredentialStore {
  /** Absolute path of the directory holding auth.json / auth-state.json. */
  dir: string;
  authFile: string;
  stateFile: string;
  region: string;
  buildEnv: string;
  apiBaseUrl: string;
  accountBaseUrl: string;
}

interface CredentialRecord {
  schemaVersion: number;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  clientId: string;
  scopes: string[];
  audience: string;
  expiresAtMs: number;
  generation: number;
  loginEpoch?: string;
}

function minimaxHome(): string {
  return join(homedir(), ".minimax");
}

/** Region recorded by MCode, e.g. "en" or "cn". */
function preferredRegion(): string | null {
  const prefs = join(minimaxHome(), "preferences", "mcode-region.json");
  try {
    const doc = JSON.parse(readFileSync(prefs, "utf8"));
    const regions = doc?.regions;
    if (regions && typeof regions === "object") {
      const region = regions.prod ?? regions.test ?? regions.staging ?? regions.dev;
      if (typeof region === "string" && REGION_HOSTS[region]) return region;
    }
  } catch {
    /* fall through to scanning */
  }
  return null;
}

/** Every credential store that actually holds a credential file. */
function candidateStores(): { dir: string; region: string; buildEnv: string }[] {
  const root = join(minimaxHome(), "auth");
  const out: { dir: string; region: string; buildEnv: string }[] = [];
  if (!existsSync(root)) return out;
  for (const buildEnv of readdirSync(root)) {
    const buildDir = join(root, buildEnv);
    if (!statSync(buildDir).isDirectory()) continue;
    for (const region of readdirSync(buildDir)) {
      const dir = join(buildDir, region, CLIENT_ID);
      if (!existsSync(join(dir, "auth.json"))) continue;
      out.push({ dir, region, buildEnv });
    }
  }
  return out;
}

/**
 * Locate the credential store for the active region.
 * Honours MATRIX_AUTH_DIR for explicit overrides.
 */
export function resolveStore(): CredentialStore {
  const override = process.env.MATRIX_AUTH_DIR?.trim();
  if (override) {
    const dir = override;
    const region = process.env.MATRIX_REGION?.trim() || "en";
    return buildStore(dir, region, "prod");
  }

  const candidates = candidateStores();
  if (!candidates.length) {
    throw new MatrixAuthError(
      "No MiniMax credential found. MCode stores its login at ~/.minimax/auth/<env>/<region>/mcode-public/auth.json. " +
        "Run MCode once and sign in, or point MATRIX_AUTH_DIR at a credential file.",
    );
  }

  const preferred = preferredRegion();
  const chosen =
    candidates.find((c) => c.region === preferred && c.buildEnv === "prod") ??
    candidates.find((c) => c.region === preferred) ??
    candidates.find((c) => c.buildEnv === "prod") ??
    candidates[0];

  return buildStore(chosen.dir, chosen.region, chosen.buildEnv);
}

function buildStore(dir: string, region: string, buildEnv: string): CredentialStore {
  const hosts = REGION_HOSTS[region] ?? REGION_HOSTS.en;
  return {
    dir,
    authFile: join(dir, "auth.json"),
    stateFile: join(dir, "auth-state.json"),
    region,
    buildEnv,
    apiBaseUrl: (process.env.MATRIX_API_BASE_URL?.trim() || hosts.api).replace(/\/+$/, ""),
    accountBaseUrl: (process.env.MATRIX_ACCOUNT_BASE_URL?.trim() || hosts.account).replace(/\/+$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Credential read / refresh / write-back
// ---------------------------------------------------------------------------

interface AuthFileDoc {
  schemaVersion: number;
  records: Record<string, CredentialRecord>;
}

function readAuthDoc(store: CredentialStore): AuthFileDoc {
  return JSON.parse(readFileSync(store.authFile, "utf8")) as AuthFileDoc;
}

/** Pick the record belonging to this store's build env + region. */
function pickRecord(doc: AuthFileDoc, store: CredentialStore): { key: string; record: CredentialRecord } {
  const prefix = `com.minimax.mcode.oauth.${store.buildEnv}.${store.region}\0`;
  const keys = Object.keys(doc.records ?? {});
  const key = keys.find((k) => k.startsWith(prefix)) ?? keys[0];
  if (!key) {
    throw new MatrixAuthError(`No credential record in ${store.authFile}.`);
  }
  return { key, record: doc.records[key] };
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, path);
}

/**
 * Refresh the OAuth credential and persist the rotated token.
 * MCode reads the same file, so writing back keeps both in sync.
 */
async function refreshCredential(store: CredentialStore, attempt = 0): Promise<string> {
  const doc = readAuthDoc(store);
  const { key, record } = pickRecord(doc, store);
  if (!record.refreshToken) {
    throw new MatrixAuthError(
      "The stored MiniMax credential has no refresh token. Sign in with MCode again to restore it.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: record.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(" "),
    audience: AUDIENCE,
  });

  let res: Response;
  try {
    res = await fetch(`${store.accountBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err: any) {
    throw new MatrixAuthError(`Could not reach ${store.accountBaseUrl}/oauth2/token: ${err?.message ?? err}`);
  }

  const text = await res.text();
  if (!res.ok) {
    // A refresh token is single-use: the moment it is redeemed the old one
    // dies. If MCode refreshed the same credential a moment earlier, our copy
    // is stale — re-read and retry with the newer token instead of failing.
    if (text.includes("invalid_grant") && attempt === 0) {
      const current = pickRecord(readAuthDoc(store), store).record;
      if (current.refreshToken && current.refreshToken !== record.refreshToken) {
        return refreshCredential(store, attempt + 1);
      }
    }
    throw new MatrixAuthError(
      `MiniMax token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}. Sign in with MCode again.`,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MatrixAuthError("MiniMax token refresh returned a non-JSON response.");
  }
  const accessToken = parsed?.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new MatrixAuthError("MiniMax token refresh returned no access_token.");
  }

  const expiresAtMs = Date.now() + Number(parsed.expires_in ?? 3600) * 1000;
  const generation = (record.generation ?? 0) + 1;

  // Re-read before writing: MCode may have refreshed concurrently, in which
  // case its newer credential wins and ours must not clobber it.
  const fresh = readAuthDoc(store);
  const freshPick = pickRecord(fresh, store);
  if ((freshPick.record.generation ?? 0) > (record.generation ?? 0)) {
    return freshPick.record.accessToken;
  }

  freshPick.record.accessToken = accessToken;
  if (typeof parsed.refresh_token === "string" && parsed.refresh_token) {
    freshPick.record.refreshToken = parsed.refresh_token;
  }
  freshPick.record.expiresAtMs = expiresAtMs;
  freshPick.record.generation = generation;
  fresh.records[freshPick.key] = freshPick.record;
  writeJsonAtomic(store.authFile, fresh);

  try {
    const state = JSON.parse(readFileSync(store.stateFile, "utf8"));
    state.generation = generation;
    state.expiresAtMs = expiresAtMs;
    writeJsonAtomic(store.stateFile, state);
  } catch {
    /* the state file is advisory; the credential file is the source of truth */
  }

  return accessToken;
}

/** A usable access token, refreshed when it is about to expire. */
async function accessToken(store: CredentialStore, force = false): Promise<string> {
  const override = process.env.MATRIX_ACCESS_TOKEN?.trim();
  if (override) return override;

  const { record } = pickRecord(readAuthDoc(store), store);
  const remaining = (record.expiresAtMs ?? 0) - Date.now();
  if (!force && record.accessToken && remaining > MIN_TOKEN_VALIDITY_MS) {
    return record.accessToken;
  }
  return refreshCredential(store);
}

// ---------------------------------------------------------------------------
// Connector API
// ---------------------------------------------------------------------------

interface ConnectorTool {
  provider: string;
  provider_tool_name: string;
  runtime_tool_name: string;
  description?: string;
}

let toolCache: { tools: ConnectorTool[]; fetchedAt: number } | null = null;
const TOOL_CACHE_TTL_MS = 5 * 60_000;

/** The connector tools available to this credential. */
export async function listTools(store: CredentialStore, attempt = 0): Promise<ConnectorTool[]> {
  if (toolCache && Date.now() - toolCache.fetchedAt < TOOL_CACHE_TTL_MS) return toolCache.tools;

  const token = await accessToken(store);
  const res = await fetch(`${store.apiBaseUrl}${CONNECTOR_TOOLS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(CONNECTOR_LIST_TIMEOUT_MS),
  });
  if (res.status === 401 && attempt === 0) {
    await refreshCredential(store);
    return listTools(store, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new MatrixApiError(`HTTP ${res.status} from ${CONNECTOR_TOOLS_PATH}: ${text.slice(0, 400)}`, res.status);
  }
  const parsed = JSON.parse(text);
  const tools: ConnectorTool[] = Array.isArray(parsed?.tools) ? parsed.tools : [];
  toolCache = { tools, fetchedAt: Date.now() };
  return tools;
}

/** Resolve the provider-side tool name for a runtime tool name. */
async function resolveToolName(store: CredentialStore, runtimeToolName: string): Promise<string> {
  const tools = await listTools(store);
  const hit = tools.find((t) => t.runtime_tool_name === runtimeToolName);
  if (hit) return hit.provider_tool_name;
  // Fall back to the matrix-prefixed convention so a list outage does not
  // break generation.
  const suffix = runtimeToolName.replace(/^connector__matrix__/, "");
  return suffix.startsWith("matrix_") ? suffix : `matrix_${suffix}`;
}

/**
 * Call a Matrix connector tool and return its parsed result.
 * `argumentsJson` is the exact payload the tool expects.
 */
export async function callConnectorTool(
  store: CredentialStore,
  runtimeToolName: string,
  args: Record<string, unknown>,
  attempt = 0,
): Promise<any> {
  const providerToolName = await resolveToolName(store, runtimeToolName);

  const payload = {
    provider: "matrix",
    provider_tool_name: providerToolName,
    runtime_tool_name: runtimeToolName,
    arguments_json: JSON.stringify(args),
  };

  let parsed: any;
  try {
    const token = await accessToken(store);
    const res = await fetch(`${store.apiBaseUrl}${CONNECTOR_CALL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONNECTOR_CALL_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new MatrixApiError(`HTTP ${res.status} from ${runtimeToolName}: ${text.slice(0, 400)}`, res.status);
    }
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MatrixApiError(`Invalid JSON response from ${runtimeToolName}: ${text.slice(0, 300)}`);
    }
  } catch (err: any) {
    if (err instanceof MatrixApiError && err.httpStatus === 401 && attempt === 0) {
      await refreshCredential(store);
      return callConnectorTool(store, runtimeToolName, args, attempt + 1);
    }
    throw err;
  }

  if (parsed?.is_error === true) {
    const code = parsed?.error_code ?? "error";
    const message = parsed?.error_message ?? "Connector tool execution failed";
    throw new MatrixApiError(`${code}: ${message}`);
  }

  const resultJson = parsed?.result_json;
  if (typeof resultJson !== "string") {
    throw new MatrixApiError(`Connector tool ${runtimeToolName} returned no result_json.`);
  }
  try {
    return JSON.parse(resultJson);
  } catch {
    throw new MatrixApiError(`Connector tool ${runtimeToolName} returned invalid result_json: ${resultJson.slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------------------
// Matrix helpers
// ---------------------------------------------------------------------------

/** Short-lived download URL for a node produced by a Matrix tool. */
export async function getAssetUrl(store: CredentialStore, nodeId: string): Promise<string> {
  const result = await callConnectorTool(store, "connector__matrix__get_asset_url", { node_id: nodeId });
  const url = result?.download_url;
  if (typeof url !== "string" || !url) {
    throw new MatrixApiError(`No download_url for node ${nodeId}: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return url;
}

/** Download a Matrix node to a local path and return the byte count. */
export async function downloadNode(store: CredentialStore, nodeId: string, destPath: string): Promise<number> {
  const url = await getAssetUrl(store, nodeId);
  const res = await fetch(url, { signal: AbortSignal.timeout(ASSET_URL_TIMEOUT_MS) });
  if (!res.ok) throw new MatrixApiError(`Download failed with HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
  return buf.length;
}

/**
 * Upload a local file and return its temporary public URL.
 * Two steps: ask the connector for a signed upload form, then POST the bytes.
 */
export async function uploadTempUrl(store: CredentialStore, filePath: string, mimeType: string): Promise<string> {
  const filename = filePath.split("/").pop() || "upload.bin";
  const signed = await callConnectorTool(store, "connector__matrix__upload_temp_url", {
    filename,
    mime_type: mimeType,
  });

  const uploadHost: string = signed?.upload_host;
  const fields: Record<string, string> = signed?.fields ?? {};
  const fileFieldName: string = signed?.file_field_name ?? "file";
  const tempUrl: string = signed?.temp_url;
  if (!uploadHost || !tempUrl) {
    throw new MatrixApiError(`Upload form was incomplete: ${JSON.stringify(signed).slice(0, 200)}`);
  }

  const bytes = readFileSync(filePath);
  const boundary = `----pi-matrix-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
        "utf8",
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
      "utf8",
    ),
  );
  parts.push(bytes);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));

  const res = await fetch(uploadHost, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(parts),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new MatrixApiError(`Upload of ${filename} failed with HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  return tempUrl;
}
