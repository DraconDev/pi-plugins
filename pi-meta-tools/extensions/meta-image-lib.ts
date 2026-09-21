/**
 * pi-meta-tools — shared REST/IO core for Meta (Muse Image) pi tools.
 *
 * Dependency-free (node built-ins only) so it can be unit-tested with plain
 * `node --test` outside pi. The pi-facing wrapper lives in meta-tools.ts.
 *
 * API shape follows Meta Model API (`muse-image-1.0`):
 *   POST {baseUrl}/images/generations   text-to-image
 *   POST {baseUrl}/images/edits         image edit / multi-reference composition
 * Auth: `Authorization: Bearer <key>` where <key> is pi's stored Meta token
 * (the minted Model API key) or MODEL_API_KEY / META_API_KEY env.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://api.meta.ai/v1";
export const DEFAULT_MODEL = "muse-image-1.0";
export const OUTPUT_FORMATS = ["webp", "png", "jpeg"] as const;
export const REASONING_STRENGTHS = ["high", "low"] as const;

export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
export type ReasoningStrength = (typeof REASONING_STRENGTHS)[number];

export interface ImageGenOptions {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  output_format?: string;
  reasoning_strength?: string;
  enable_image_search?: boolean;
  enable_web_search?: boolean;
  enable_shell?: boolean;
  /** Reference images for /images/edits (URLs, data URIs, or local paths). */
  images?: string[];
}

export interface SavedImage {
  filePath: string;
  mimeType: string;
  remoteUrl: string | null;
}

/** Injectable seams for tests (defaults hit the real environment). */
export interface ResolveDeps {
  env?: NodeJS.ProcessEnv;
  readAuthFile?: (path: string) => string;
  runPiAuth?: (args: string[]) => string;
}

function defaultReadAuthFile(path: string): string {
  return readFileSync(path, "utf8");
}

function defaultRunPiAuth(args: string[]): string {
  return execFileSync("pi", args, { encoding: "utf8", timeout: 60_000 });
}

/**
 * Resolve a Meta Model API key without any new login step.
 *
 * Order: MODEL_API_KEY / META_MODEL_API_KEY / META_API_KEY / MUSE_API_KEY env,
 * then `pi auth print-bearer-token --provider meta` (auto-refreshes pi's stored
 * OAuth credentials when expired), then a direct read of the minted key in
 * ~/.pi/agent/auth.json as a fallback.
 */
export function resolveApiKey(deps: ResolveDeps = {}): string {
  const env = deps.env ?? process.env;
  const readAuthFile = deps.readAuthFile ?? defaultReadAuthFile;
  const runPiAuth = deps.runPiAuth ?? defaultRunPiAuth;

  for (const name of ["MODEL_API_KEY", "META_MODEL_API_KEY", "META_API_KEY", "MUSE_API_KEY"]) {
    const value = env[name];
    if (value && value.trim()) return value.trim();
  }

  try {
    const token = runPiAuth(["auth", "print-bearer-token", "--provider", "meta"]).trim();
    if (token) return token;
  } catch {
    // fall through to the direct auth.json read
  }

  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readAuthFile(authPath)) as Record<string, { access?: string }>;
    const entry = auth["meta"];
    if (entry && typeof entry.access === "string" && entry.access.trim()) return entry.access.trim();
  } catch {
    // fall through to the error below
  }

  throw new Error(
    "No Meta credential found. Run /login with the meta provider in pi, or set the MODEL_API_KEY environment variable.",
  );
}

export function resolveBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env["META_MODEL_API_BASE_URL"] || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function checkSize(size: string): void {
  if (!/^\d+x\d+$/i.test(size)) {
    throw new Error('Invalid size "' + size + '": expected an aspect hint like "1024x1024".');
  }
}

/** Build the JSON body for /images/generations or /images/edits. */
export function buildImagePayload(opts: ImageGenOptions): Record<string, unknown> {
  const prompt = (opts.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required.");
  const n = opts.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("n must be an integer between 1 and 10.");
  const outputFormat = (opts.output_format || "png").toLowerCase();
  if (!(OUTPUT_FORMATS as readonly string[]).includes(outputFormat)) {
    throw new Error("output_format must be one of " + OUTPUT_FORMATS.join(", ") + '.');
  }
  const strength = (opts.reasoning_strength || "high").toLowerCase();
  if (!(REASONING_STRENGTHS as readonly string[]).includes(strength)) {
    throw new Error("reasoning_strength must be one of " + REASONING_STRENGTHS.join(", ") + ".");
  }
  if (opts.size) checkSize(opts.size);

  const payload: Record<string, unknown> = {
    model: (opts.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    prompt,
    n,
    output_format: outputFormat,
    response_format: "b64_json",
    reasoning_strength: strength,
  };
  if (opts.size) payload["size"] = opts.size;
  const imageSearch = opts.enable_image_search ?? true;
  const webSearch = opts.enable_web_search ?? true;
  const shell = opts.enable_shell ?? true;
  if (!imageSearch || !webSearch || !shell) {
    payload["tool_enablement"] = {
      enable_image_search: imageSearch,
      enable_web_search: webSearch,
      enable_shell: shell,
    };
  }
  if (opts.images && opts.images.length > 0) {
    payload["images"] = opts.images.map((uri) => ({ image_url: uri }));
  }
  return payload;
}

/**
 * Normalize one reference image to a URL/data-URI string the API accepts.
 * Accepts http(s) URLs, data URIs, and local file paths.
 */
export function prepareImageUri(input: string, readFile: (path: string) => Buffer = (p) => readFileSync(p)): string {
  const value = (input || "").trim();
  if (!value) throw new Error("Empty image reference.");
  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("data:")) return value;
  if (!existsSync(value)) throw new Error("Image path does not exist: " + value);
  const ext = value.toLowerCase().split(".").pop() || "";
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/png";
  return "data:" + mime + ";base64," + readFile(value).toString("base64");
}

export interface ParsedImageItem {
  b64: string | null;
  url: string | null;
  mimeType: string | null;
}

/** Extract data[] items ({b64_json} or {url}) from an API response body. */
export function parseImageResponse(body: unknown): ParsedImageItem[] {
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Meta image API returned no image data");
  }
  return data.map((item) => {
    const row = item as { b64_json?: unknown; url?: unknown; mime_type?: unknown };
    const b64 = typeof row.b64_json === "string" && row.b64_json ? row.b64_json : null;
    const url = typeof row.url === "string" && row.url ? row.url : null;
    if (!b64 && !url) throw new Error("Meta image API item has neither b64_json nor url");
    return {
      b64,
      url,
      mimeType: typeof row.mime_type === "string" ? row.mime_type : null,
    };
  });
}

export function fileLink(p: string, label: string = p): string {
  return "[" + label + "](" + pathToFileURL(p).href + ")";
}

function extFor(mimeType: string, outputFormat: string): string {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("png")) return "png";
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
}

async function download(url: string, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) throw new Error("Unable to download image: HTTP " + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Persist one generated image under .pi/generated-images/ (project-relative).
 * Prefers inline b64 data; falls back to downloading the remote URL.
 */
export async function saveImageItem(
  item: ParsedImageItem,
  opts: { model: string; index: number; outputFormat: string; signal?: AbortSignal },
): Promise<SavedImage> {
  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mimeType = item.mimeType || "image/" + (opts.outputFormat === "jpg" ? "jpeg" : opts.outputFormat);
  const filePath = join(directory, opts.model + "-" + Date.now() + "-" + opts.index + "." + extFor(mimeType, opts.outputFormat));
  if (item.b64) {
    await writeFile(filePath, Buffer.from(item.b64, "base64"));
  } else if (item.url) {
    await writeFile(filePath, await download(item.url, opts.signal));
  } else {
    throw new Error("Meta image API returned no url or b64_json");
  }
  return { filePath, mimeType, remoteUrl: item.url };
}

export function formatSavedImages(saved: SavedImage[]): string {
  const lines = saved.map((s, i) => {
    const label = saved.length > 1 ? "Image " + (i + 1) : "Image";
    return s.remoteUrl
      ? label + ": ![](" + s.remoteUrl + ")\nSaved local copy: " + fileLink(s.filePath)
      : label + " saved to: " + fileLink(s.filePath);
  });
  const note =
    "\n\nRemote image URLs may expire according to Meta retention policy; the local copy is permanent.";
  return lines.join("\n\n") + (saved.some((s) => s.remoteUrl) ? note : "");
}

export function errorHint(status: number): string {
  if (status === 401 || status === 403) {
    return " (Meta rejected the credential — run /login with the meta provider in pi, or set a Model API key from https://dev.meta.ai/docs/authentication as MODEL_API_KEY)";
  }
  return "";
}
