/**
 * pi-matrix-tools
 *
 * Exposes MiniMax's internal Matrix image generation to pi as three tools:
 *
 *   - matrix_image              generate new images (1K/2K/4K, six aspect ratios)
 *   - matrix_enhance            2x super-resolution of an existing image
 *   - matrix_remove_background  transparent-PNG cutout of an existing image
 *
 * Why this exists:
 * The public MiniMax API only exposes `image-01` / `image-01-live`, and both
 * hard-cap the output at 2048px (the `mmx` CLI only speaks that public API).
 * The Matrix connector serves a newer high-resolution image model that reaches
 * 4096x4096 and 6336x2688 and is not reachable through api.minimax.io. This
 * extension is the way to get that model from pi.
 *
 * Transport:
 * The `mcode-tools` CLI. It is a thin host-managed shim that reaches the
 * Matrix backend through a shared auth broker on a unix socket, and it needs
 * five __MAVIS_MCODE_TOOLS_* variables that MCode injects into its own
 * process. Those variables are NOT in any shell rc file, so a plain `pi`
 * launch cannot use mcode-tools as-is. This extension re-discovers the lease
 * itself (see resolveHostEnv), which makes the tools work from a standalone
 * pi session.
 *
 * Requirement: MCode must be running, because the auth lease only exists for
 * the lifetime of the MCode process that owns it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

// typebox is provided to extensions by pi itself (bundled/virtual module).
import * as _typebox from "typebox";
const Type = _typebox.Type;

// ---------------------------------------------------------------------------
// Host environment / lease discovery
// ---------------------------------------------------------------------------

const HOST_ENV_KEYS = [
  "__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE",
  "__MAVIS_MCODE_TOOLS_CONFIG_DIR",
  "__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE",
  "__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT",
  "__MAVIS_MCODE_TOOLS_REGION",
] as const;

/** Newest lease dir under ~/.minimax/run/mt-*, or null when MCode is not running. */
function findLease(): { cap: string; sock: string; mtime: number } | null {
  const root = join(homedir(), ".minimax", "run");
  if (!existsSync(root)) return null;
  let best: { cap: string; sock: string; mtime: number } | null = null;
  for (const name of readdirSync(root)) {
    if (!name.startsWith("mt-")) continue;
    const dir = join(root, name);
    const cap = join(dir, "mcode-auth-lease-v1.cap");
    const sock = join(dir, "mcode-auth-lease-v1.sock");
    if (!existsSync(cap) || !existsSync(sock)) continue;
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      /* ignore */
    }
    if (!best || mtime > best.mtime) best = { cap, sock, mtime };
  }
  return best;
}

/** Region-scoped config dir, e.g. ~/.minimax/integrations/mcode-tools/en */
function findConfigDir(region: string): string {
  const base = join(homedir(), ".minimax", "integrations", "mcode-tools");
  const exact = join(base, region);
  if (existsSync(exact)) return exact;
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      const p = join(base, name);
      if (statSync(p).isDirectory()) return p;
    }
  }
  return exact;
}

/** A node binary capable of running the mcode-tools entry script. */
function findNode(): string {
  const fromHost = process.env.__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE;
  if (fromHost && existsSync(fromHost)) return fromHost;
  if (/(^|[/\\])node([0-9.]*)?$/.test(process.execPath)) return process.execPath;
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "node");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find a node binary to run mcode-tools. Set __MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE or put node on PATH.",
  );
}

/** The mcode-tools launcher. */
function findMcodeTools(): string {
  const override = process.env.MCODE_TOOLS_BIN;
  if (override && existsSync(override)) return override;
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, "mcode-tools");
    if (existsSync(candidate)) return candidate;
  }
  const fallback = join(homedir(), ".npm-global", "bin", "mcode-tools");
  if (existsSync(fallback)) return fallback;
  throw new Error("Could not find the mcode-tools CLI on PATH. Install @minimax-ai/code or set MCODE_TOOLS_BIN.");
}

/**
 * Build the five __MAVIS_MCODE_TOOLS_* variables the shim needs.
 * Prefers the ones already in the environment (i.e. we are running inside
 * MCode), otherwise re-discovers the live auth lease.
 */
function resolveHostEnv(): Record<string, string> {
  if (HOST_ENV_KEYS.every((k) => process.env[k])) {
    const out: Record<string, string> = {};
    for (const k of HOST_ENV_KEYS) out[k] = process.env[k] as string;
    return out;
  }

  const lease = findLease();
  if (!lease) {
    throw new Error(
      "No Matrix auth lease found. mcode-tools authenticates through a shared broker owned by the MCode host, " +
        "so MCode must be running. Start MCode and retry.",
    );
  }

  const region = process.env.__MAVIS_MCODE_TOOLS_REGION || "en";
  return {
    __MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE: findNode(),
    __MAVIS_MCODE_TOOLS_CONFIG_DIR: findConfigDir(region),
    __MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE: lease.cap,
    __MAVIS_MCODE_TOOLS_BROKER_ENDPOINT: lease.sock,
    __MAVIS_MCODE_TOOLS_REGION: region,
  };
}

// ---------------------------------------------------------------------------
// mcode-tools invocation
// ---------------------------------------------------------------------------

function runMcode(args: string[], timeoutMs = 900_000): string {
  const env = { ...process.env, ...resolveHostEnv() };
  let stdout: string;
  let stderr: string;
  try {
    stdout = execFileSync(findMcodeTools(), args, {
      encoding: "utf8",
      env,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    stderr = "";
  } catch (err: any) {
    const detail = (err?.stderr || err?.message || String(err)).toString().trim();
    if (detail.includes("MCode mcode-tools runtime is unavailable")) {
      throw new Error(
        "mcode-tools could not reach the MCode host runtime. Make sure MCode is running so the auth lease is live.",
      );
    }
    throw new Error(`mcode-tools ${args[0]} failed: ${detail}`);
  }
  void stderr;
  return stdout;
}

/** Call a Matrix connector tool and return its parsed JSON result. */
function callConnector(tool: string, args: Record<string, unknown>): any {
  const tmp = join(tmpdir(), `mcode-args-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(tmp, JSON.stringify(args));
  try {
    const out = runMcode(["connector", "call", tool, "--args-file", tmp]);
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`Could not parse mcode-tools output for ${tool}: ${out.slice(0, 300)}`);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Fetch a short-lived download URL for a Matrix drive node. */
function assetUrl(nodeId: string): string {
  const out = runMcode(["get_asset_url", nodeId], 180_000);
  const parsed = JSON.parse(out);
  if (!parsed?.download_url) throw new Error(`No download_url for node ${nodeId}`);
  return parsed.download_url;
}

/** Upload a local file and return its temporary public URL. */
function uploadTempUrl(filePath: string): string {
  const out = runMcode(["upload_temp_url", filePath], 300_000);
  const parsed = JSON.parse(out);
  if (!parsed?.temp_url) throw new Error(`Upload of ${filePath} did not return a temp_url`);
  return parsed.temp_url;
}

/** Download a Matrix node to a local path. */
async function downloadNode(nodeId: string, destPath: string): Promise<number> {
  const res = await fetch(assetUrl(nodeId));
  if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(join(destPath, ".."), { recursive: true });
  writeFileSync(destPath, buf);
  return buf.length;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT_DIR = join(".pi", "generated-images");

function resolveOutputDir(outputDir?: string): string {
  const dir = resolve(outputDir || DEFAULT_OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "image"
  );
}

function withExt(base: string, ext: string): string {
  return `${safeName(base)}${ext.startsWith(".") ? ext : "." + ext}`;
}

function fileLink(path: string, label?: string): string {
  return `[${label || path}](file://${path})`;
}

// ---------------------------------------------------------------------------
// Tool parameter schemas
// ---------------------------------------------------------------------------

const aspectRatio = Type.Optional(
  Type.Union(
    [
      Type.Literal("1:1"),
      Type.Literal("16:9"),
      Type.Literal("9:16"),
      Type.Literal("4:3"),
      Type.Literal("3:4"),
      Type.Literal("21:9"),
    ],
    {
      description:
        "Output aspect ratio. Default 1:1. Native sizes: 21:9 -> 3168x1344 at 2K and 6336x2688 at 4K; " +
        "9:16 -> 3072x5504 at 4K; 16:9 -> 2752x1536 at 2K.",
    },
  ),
);

const resolution = Type.Optional(
  Type.Union([Type.Literal("1K"), Type.Literal("2K"), Type.Literal("4K")], {
    description:
      "Output size tier. 1K is fastest, 4K is the max detail (4096x4096 square, up to 6336x2688 at 21:9). Default 2K.",
  }),
);

const outputDir = Type.Optional(
  Type.String({
    description:
      "Directory to write the image(s) into. Default .pi/generated-images/ under the current working directory.",
  }),
);

const imageParams = Type.Object({
  prompt: Type.String({
    description:
      "Detailed description of the image. The model handles rich multi-constraint prompts well: subject, lighting, " +
      "lens, mood, texture and post-processing style all improve results when stated explicitly.",
  }),
  aspect_ratio: aspectRatio,
  resolution: resolution,
  count: Type.Optional(
    Type.Number({
      description: "How many images to generate in one batch (1-4). Default 1.",
      minimum: 1,
      maximum: 4,
    }),
  ),
  output_dir: outputDir,
  output_prefix: Type.Optional(
    Type.String({
      description: "Base filename for the saved image(s), without extension. Default 'matrix-image'.",
    }),
  ),
});

const editParams = Type.Object({
  image_path: Type.String({
    description: "Absolute or relative path to a local image file (PNG, JPEG or WebP).",
  }),
  output_dir: outputDir,
  output_prefix: Type.Optional(
    Type.String({
      description: "Base filename for the saved result, without extension.",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

interface SavedImage {
  path: string;
  bytes: number;
  nodeId: string;
}

async function executeImage(_toolCallId: string, params: any): Promise<any> {
  const prompt = String(params.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt is required.");

  const ar = params.aspect_ratio || "1:1";
  const res = params.resolution || "2K";
  const count = Math.max(1, Math.min(4, Number(params.count) || 1));
  const dir = resolveOutputDir(params.output_dir);
  const prefix = safeName(params.output_prefix || "matrix-image");

  const requests = Array.from({ length: count }, (_, i) => ({
    prompt,
    aspect_ratio: ar,
    resolution: res,
    output_file: count > 1 ? `${prefix}-${i + 1}` : prefix,
  }));

  const result = callConnector("connector__matrix__generate_image", { requests });
  const items: any[] = result?.success_items || [];
  if (!items.length) {
    const failed = result?.failed_items?.length ? JSON.stringify(result.failed_items) : "no reason reported";
    throw new Error(`Matrix image generation produced no images (${failed}).`);
  }

  const saved: SavedImage[] = [];
  for (const item of items) {
    const ext = extname(item.file_name || "") || ".jpg";
    const stem = basename(item.file_name || "", ext);
    const dest = join(dir, withExt(stem || prefix, ext));
    const bytes = await downloadNode(item.node_id, dest);
    saved.push({ path: dest, bytes, nodeId: item.node_id });
  }

  const text =
    `Generated ${saved.length} image(s) at ${res} ${ar}.\n\n` +
    saved.map((s) => `- ${fileLink(s.path)} (${Math.round(s.bytes / 1024)} KB)`).join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      files: saved.map((s) => s.path),
      nodeIds: saved.map((s) => s.nodeId),
      aspect_ratio: ar,
      resolution: res,
    },
  };
}

async function executeEnhance(_toolCallId: string, params: any): Promise<any> {
  const src = resolve(String(params.image_path || ""));
  if (!existsSync(src)) throw new Error(`No such file: ${src}`);
  const dir = resolveOutputDir(params.output_dir);
  const prefix = safeName(params.output_prefix || basename(src, extname(src)) + "-2x");

  const tempUrl = uploadTempUrl(src);
  const result = callConnector("connector__matrix__enhance_image", { image_url: tempUrl });
  if (!result?.node_id) throw new Error(`Enhance failed: ${JSON.stringify(result)}`);

  const ext = extname(result.file_name || "") || ".jpg";
  const dest = join(dir, withExt(prefix, ext));
  const bytes = await downloadNode(result.node_id, dest);

  const text =
    `Enhanced to ${result.width}x${result.height} (2x).\n\n- ${fileLink(dest)} (${Math.round(bytes / 1024)} KB)`;

  return {
    content: [{ type: "text", text }],
    details: { files: [dest], nodeIds: [result.node_id], width: result.width, height: result.height },
  };
}

async function executeRemoveBackground(_toolCallId: string, params: any): Promise<any> {
  const src = resolve(String(params.image_path || ""));
  if (!existsSync(src)) throw new Error(`No such file: ${src}`);
  const dir = resolveOutputDir(params.output_dir);
  const prefix = safeName(params.output_prefix || basename(src, extname(src)) + "-nobg");

  const tempUrl = uploadTempUrl(src);
  const result = callConnector("connector__matrix__remove_image_background", { image_url: tempUrl });
  if (!result?.node_id) throw new Error(`Background removal failed: ${JSON.stringify(result)}`);

  const ext = extname(result.file_name || "") || ".png";
  const dest = join(dir, withExt(prefix, ext));
  const bytes = await downloadNode(result.node_id, dest);

  const text = `Removed background, saved transparent PNG (${result.width}x${result.height}).\n\n- ${fileLink(dest)} (${Math.round(bytes / 1024)} KB)`;

  return {
    content: [{ type: "text", text }],
    details: { files: [dest], nodeIds: [result.node_id], width: result.width, height: result.height },
  };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: any) {
  pi.registerTool({
    name: "matrix_image",
    label: "Matrix Image",
    description:
      "Generate images with MiniMax's internal Matrix image model — the high-resolution model behind the Matrix " +
      "connector, which reaches 4096x4096 and 6336x2688 and is NOT available through the public MiniMax API " +
      "(image-01 / image-01-live cap at 2048px, which is what the mmx CLI uses). " +
      "Supports aspect ratios 1:1, 16:9, 9:16, 4:3, 3:4, 21:9 at 1K / 2K / 4K, and up to 4 images per call. " +
      "Strong on photorealism, macro detail, legible typography, volumetric light and material physics. " +
      "Saves under .pi/generated-images/ and returns the local path. " +
      "Requires MCode to be running (the Matrix auth lease is owned by the MCode host).",
    parameters: imageParams,
    executionMode: "sequential",
    execute: executeImage,
  });

  pi.registerTool({
    name: "matrix_enhance",
    label: "Matrix Enhance",
    description:
      "Upscale an existing local image 2x via the Matrix connector's super-resolution pass. " +
      "Input must be PNG, JPEG or WebP, at most 10 MB, short side at least 256px and long side at most 2048px. " +
      "Saves the result under .pi/generated-images/ and returns the local path. " +
      "Requires MCode to be running.",
    parameters: editParams,
    executionMode: "parallel",
    execute: executeEnhance,
  });

  pi.registerTool({
    name: "matrix_remove_background",
    label: "Matrix Remove Background",
    description:
      "Remove the background from an existing local image and save a transparent PNG via the Matrix connector. " +
      "Works best with a clear, single main subject. " +
      "Saves the result under .pi/generated-images/ and returns the local path. " +
      "Requires MCode to be running.",
    parameters: editParams,
    executionMode: "parallel",
    execute: executeRemoveBackground,
  });
}
