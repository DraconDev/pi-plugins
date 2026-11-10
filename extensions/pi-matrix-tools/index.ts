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
 * A direct HTTPS call to the MiniMax agent backend
 * (agent.minimax.io/minimax-cloud/api/v1/connectors/...). The bearer token is
 * the OAuth credential MCode already persists at
 * ~/.minimax/auth/<env>/<region>/mcode-public/auth.json; the extension
 * refreshes it on demand and writes the rotated credential back, so MCode and
 * this extension share one login.
 *
 * Requirement: MCode does NOT need to be running. It only needs to have been
 * signed in once, so that the credential file exists.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

// typebox is provided to extensions by pi itself (bundled/virtual module).
import * as _typebox from "typebox";
const Type = _typebox.Type;

import {
  MatrixApiError,
  MatrixAuthError,
  callConnectorTool,
  downloadNode,
  resolveStore,
  uploadTempUrl,
} from "./matrix-client";

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

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".bmp") return "image/bmp";
  if (ext === ".tif" || ext === ".tiff") return "image/tiff";
  return "image/jpeg";
}

/** Turn client failures into messages that say what to actually do. */
function describeError(err: unknown): string {
  if (err instanceof MatrixAuthError) {
    return (
      `${err.message} ` +
      "Sign in with MCode once (it stores the credential at ~/.minimax/auth/<env>/<region>/mcode-public/auth.json), " +
      "then retry."
    );
  }
  if (err instanceof MatrixApiError) return err.message;
  const message = (err as any)?.message ?? String(err);
  return message;
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

  const store = resolveStore();
  let result: any;
  try {
    result = await callConnectorTool(store, "connector__matrix__generate_image", { requests });
  } catch (err) {
    throw new Error(describeError(err));
  }

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
    const bytes = await downloadNode(store, item.node_id, dest);
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

  const store = resolveStore();
  let result: any;
  try {
    const tempUrl = await uploadTempUrl(store, src, mimeFor(src));
    result = await callConnectorTool(store, "connector__matrix__enhance_image", { image_url: tempUrl });
  } catch (err) {
    throw new Error(describeError(err));
  }
  if (!result?.node_id) throw new Error(`Enhance failed: ${JSON.stringify(result)}`);

  const ext = extname(result.file_name || "") || ".jpg";
  const dest = join(dir, withExt(prefix, ext));
  const bytes = await downloadNode(store, result.node_id, dest);

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

  const store = resolveStore();
  let result: any;
  try {
    const tempUrl = await uploadTempUrl(store, src, mimeFor(src));
    result = await callConnectorTool(store, "connector__matrix__remove_image_background", {
      image_url: tempUrl,
    });
  } catch (err) {
    throw new Error(describeError(err));
  }
  if (!result?.node_id) throw new Error(`Background removal failed: ${JSON.stringify(result)}`);

  const ext = extname(result.file_name || "") || ".png";
  const dest = join(dir, withExt(prefix, ext));
  const bytes = await downloadNode(store, result.node_id, dest);

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
      "Uses the MiniMax account already signed in on this machine — MCode does not need to be running.",
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
      "Uses the MiniMax account already signed in on this machine — MCode does not need to be running.",
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
      "Uses the MiniMax account already signed in on this machine — MCode does not need to be running.",
    parameters: editParams,
    executionMode: "parallel",
    execute: executeRemoveBackground,
  });
}
