import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";

import type { MockupSpec, NormalizedImageGeneration, NormalizedOption, NormalizedReview } from "./schema.ts";

import { DEFAULT_MOCKUP_CELLS, renderMockup } from "./mockup-renderer.ts";
import { composePreview, decodeArt } from "./preview-composer.ts";

export const DEFAULT_IMAGE_PROVIDER = "agnes";
export const DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash";
export const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_IMAGE_REQUEST_TIMEOUT_MS = 120_000;

type AgnesEndpoint = "agnes" | "agnes-cn";

const ENDPOINTS: Record<AgnesEndpoint, { baseUrl: string; env: string }> = {
  agnes: { baseUrl: "https://apihub.agnes-ai.com/v1", env: "AGNES_API_KEY" },
  "agnes-cn": { baseUrl: "https://api.agnes-ai.cn/v1", env: "AGNES_CN_API_KEY" },
};

export interface GeneratedImage {
  path: string;
  mimeType: string;
  provider: string;
  model: string;
  prompt: string;
  byteCount: number;
  remoteUrl?: string;
}

export interface ImageGeneratorOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Injectable for deterministic tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable credential resolver; defaults to env vars and Pi's auth store. */
  resolveCredential?: (provider: AgnesEndpoint) => string | undefined;
  /** Injectable fetch implementation alias for callers that use a wrapped fetch. */
  fetcher?: typeof fetch;
  /** Injectable clock and id source for deterministic file names/tests. */
  now?: () => number;
  randomId?: () => string;
  timeoutMs?: number;
  outputDir?: string;
  onProgress?: (progress: { completed: number; total: number; option: NormalizedOption; image: GeneratedImage }) => void;
}

export class ImageGenerationError extends Error {
  readonly code: "unsupported_provider" | "missing_credential" | "invalid_model" | "request_failed" | "invalid_response" | "aborted" | "io_error" | "invalid_request";

  constructor(code: ImageGenerationError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImageGenerationError";
    this.code = code;
  }
}

function endpointFor(provider: string): AgnesEndpoint {
  if (provider === "agnes" || provider === "agnes-cn") return provider;
  throw new ImageGenerationError(
    "unsupported_provider",
    `Unsupported image provider "${provider}". This package currently supports "agnes" and "agnes-cn".`,
  );
}

function defaultCredentialResolver(provider: AgnesEndpoint): string | undefined {
  const envName = ENDPOINTS[provider].env;
  const fromEnv = process.env[envName]?.trim();
  if (fromEnv) return fromEnv;

  try {
    const credential = readStoredCredential(provider, join(getAgentDir(), "auth.json"));
    if (credential && "key" in credential && typeof credential.key === "string" && credential.key.trim()) {
      return credential.key.trim();
    }
  } catch {
    // A missing or malformed auth store is handled as a missing credential below.
  }
  return undefined;
}

function isAgnesImageModel(model: string): boolean {
  return model.startsWith("agnes-image-") && model.length <= 200;
}

function normalizeMimeType(value: string | undefined, bytes: Buffer): string {
  const candidate = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (candidate && /^image\/(png|jpeg|jpg|webp|gif)$/.test(candidate)) {
    return candidate === "image/jpg" ? "image/jpeg" : candidate;
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "application/octet-stream";
}

function assertImageBytes(bytes: Buffer, mimeType: string): void {
  if (bytes.length === 0) throw new ImageGenerationError("invalid_response", "The image provider returned an empty image.");
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new ImageGenerationError("invalid_response", `Generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES}-byte limit.`);
  }
  if (!mimeType.startsWith("image/")) {
    throw new ImageGenerationError("invalid_response", `Generated image has unsupported MIME type ${mimeType}.`);
  }
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isGif = bytes.subarray(0, 3).toString("ascii") === "GIF";
  const isWebp = bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  const signatureMatches =
    (mimeType === "image/png" && isPng) ||
    (mimeType === "image/jpeg" && isJpeg) ||
    (mimeType === "image/gif" && isGif) ||
    (mimeType === "image/webp" && isWebp);
  if (!signatureMatches) {
    throw new ImageGenerationError("invalid_response", `Generated bytes do not match the declared ${mimeType} image type.`);
  }
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw new ImageGenerationError("invalid_response", "The image provider returned invalid base64 image data.");
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== compact) {
    throw new ImageGenerationError("invalid_response", "The image provider returned invalid base64 image data.");
  }
  return bytes;
}

function safePart(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || fallback;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("Image generation timed out.")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function readResponseBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new ImageGenerationError("invalid_response", "The generated image exceeds the size limit.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_GENERATED_IMAGE_BYTES) {
    throw new ImageGenerationError("invalid_response", "The generated image exceeds the size limit.");
  }
  signal.throwIfAborted();
  return bytes;
}

async function responseError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = await response.text();
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
      detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message ?? "";
    } catch {
      detail = body;
    }
  } catch {
    // Use the status text below when the body cannot be read.
  }
  return detail ? `HTTP ${response.status}: ${detail.slice(0, 500)}` : `HTTP ${response.status} ${response.statusText}`.trim();
}

async function downloadRemoteImage(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<{ bytes: Buffer; mimeType?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageGenerationError("invalid_response", "The image provider returned an invalid image URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ImageGenerationError("invalid_response", "The image provider returned a non-HTTP image URL.");
  }
  let response: Response;
  try {
    response = await fetcher(url, { signal, redirect: "follow" });
  } catch (error) {
    if (signal.aborted) throw new ImageGenerationError("aborted", "Image download was cancelled.", { cause: error });
    throw new ImageGenerationError("request_failed", `Unable to download generated image: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new ImageGenerationError("request_failed", `Unable to download generated image (${response.status}).`);
  return { bytes: await readResponseBytes(response, signal), mimeType: response.headers.get("content-type") ?? undefined };
}

async function saveBytes(
  bytes: Buffer,
  mimeType: string,
  request: NormalizedImageGeneration,
  provider: AgnesEndpoint,
  model: string,
  options: ImageGeneratorOptions,
): Promise<GeneratedImage> {
  assertImageBytes(bytes, mimeType);
  const directory = options.outputDir ?? join(options.cwd, ".pi", "generated-images");
  const now = options.now ?? Date.now;
  const id = (options.randomId ?? randomUUID)();
  const stem = `${safePart(provider, "image")}-${safePart(model, "model")}-${now()}-${safePart(id, "image")}`;
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "bin";
  const path = join(directory, `${stem}.${extension}`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ImageGenerationError("io_error", `Unable to save generated image: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return { path, mimeType, provider, model, prompt: request.prompt, byteCount: bytes.length };
}

async function requestImage(
  request: NormalizedImageGeneration,
  provider: AgnesEndpoint,
  model: string,
  options: ImageGeneratorOptions,
): Promise<GeneratedImage> {
  const apiKey = (options.resolveCredential ?? defaultCredentialResolver)(provider);
  if (!apiKey) {
    throw new ImageGenerationError(
      "missing_credential",
      `No ${ENDPOINTS[provider].env} credential is available. Set ${ENDPOINTS[provider].env} or run /login for ${provider}.`,
    );
  }
  if (!isAgnesImageModel(model)) {
    throw new ImageGenerationError("invalid_model", `Unsupported Agnes image model "${model}". Use an agnes-image-* model id.`);
  }

  const prompt = request.negativePrompt
    ? `${request.prompt}\n\nAvoid: ${request.negativePrompt}`
    : request.prompt;
  const body: Record<string, unknown> = {
    model,
    prompt,
    response_format: "b64_json",
  };
  if (request.size) body.size = request.size;

  const timeoutMs = options.timeoutMs ?? DEFAULT_IMAGE_REQUEST_TIMEOUT_MS;
  const timeout = withTimeout(options.signal, timeoutMs);
  const fetchImpl = options.fetchImpl ?? options.fetcher ?? fetch;
  let timedOut = false;
  const timeoutTimer = setTimeout(() => { timedOut = true; }, timeoutMs);
  timeoutTimer.unref?.();
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${ENDPOINTS[provider].baseUrl}/images/generations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: timeout.signal,
        redirect: "error",
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ImageGenerationError("aborted", "Image generation was cancelled.", { cause: error });
      }
      if (timedOut || timeout.signal.aborted) {
        throw new ImageGenerationError("request_failed", `Image generation timed out after ${timeoutMs}ms.`, { cause: error });
      }
      throw new ImageGenerationError("request_failed", `Image generation request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (!response.ok) throw new ImageGenerationError("request_failed", `Image generation failed (${await responseError(response)}).`);

    const payload = (await response.json().catch((error) => {
      throw new ImageGenerationError("invalid_response", "The image provider returned invalid JSON.", { cause: error });
    })) as { data?: Array<{ b64_json?: unknown; url?: unknown; mime_type?: unknown }> };
    const image = payload.data?.[0];
    if (!image || typeof image !== "object") throw new ImageGenerationError("invalid_response", "The image provider returned no image data.");

    let bytes: Buffer;
    let mimeType: string | undefined;
    let remoteUrl: string | undefined;
    if (typeof image.b64_json === "string") {
      bytes = decodeBase64(image.b64_json);
      mimeType = typeof image.mime_type === "string" ? image.mime_type : undefined;
    } else if (typeof image.url === "string" && image.url) {
      remoteUrl = image.url;
      const downloaded = await downloadRemoteImage(image.url, timeout.signal, fetchImpl);
      bytes = downloaded.bytes;
      mimeType = downloaded.mimeType;
    } else {
      throw new ImageGenerationError("invalid_response", "The image provider returned neither b64_json nor url.");
    }
    const resolvedMime = normalizeMimeType(mimeType, bytes);
    const saved = await saveBytes(bytes, resolvedMime, { ...request, prompt }, provider, model, options);
    return remoteUrl ? { ...saved, remoteUrl } : saved;
  } finally {
    clearTimeout(timeoutTimer);
    timeout.dispose();
  }
}

function effectiveGeneration(review: NormalizedReview, option: NormalizedOption): NormalizedImageGeneration | undefined {
  if (!option.generate) return undefined;
  return {
    ...option.generate,
    provider: option.generate.provider ?? review.provider ?? review.generation?.provider ?? DEFAULT_IMAGE_PROVIDER,
    model: option.generate.model ?? review.model ?? review.generation?.model ?? DEFAULT_IMAGE_MODEL,
  };
}

export interface GeneratedReviewImages {
  review: NormalizedReview;
  images: GeneratedImage[];
}

/**
 * Draw an option's deterministic mockup.
 *
 * No provider is involved: the bytes come from the option's own content, so the
 * same spec renders the same image on every machine and nothing is sampled.
 */
export async function renderOptionMockup(
  option: NormalizedOption,
  options: ImageGeneratorOptions,
): Promise<GeneratedImage> {
  const spec = option.mockup;
  if (!spec) throw new ImageGenerationError("invalid_request", "Option has no mockup to render.");
  const now = options.now ?? Date.now;
  const id = (options.randomId ?? randomUUID)();
  const stem = `mockup-${safePart(option.id, "option")}-${now()}-${safePart(id, "mockup")}`;
  const directory = options.outputDir ?? join(options.cwd, ".pi", "generated-images");
  const path = join(directory, `${stem}.png`);
  const rendered = renderMockup(spec as MockupSpec, {
    widthCells: spec.widthCells ?? DEFAULT_MOCKUP_CELLS.widthCells,
    heightCells: spec.heightCells ?? DEFAULT_MOCKUP_CELLS.heightCells,
  });
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, rendered.png, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ImageGenerationError("io_error", `Unable to save mockup image: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return {
    path,
    mimeType: "image/png",
    provider: "mockup",
    model: "deterministic-cell-renderer",
    prompt: `mockup:${option.id}`,
    byteCount: rendered.png.length,
  };
}

/**
 * Compose an option's generated art into its deterministic structure.
 *
 * An option can carry both a `mockup` spec and a `generate` request. The
 * benchmark measured why that combination matters: a generated image judged on
 * the 31 x 16 cell grid the terminal shows carries a shape and an emphasis but
 * almost never the information the question is about, and 34.5% of raw
 * generated previews were charged as severe failures. The information-bearing
 * layer is therefore drawn deterministically and the art is placed inside it, so
 * a preview is never less informative than the text presentation and never
 * illegible because a model invented its own typography.
 */
export async function renderComposedMockup(
  option: NormalizedOption,
  art: GeneratedImage,
  options: ImageGeneratorOptions,
): Promise<GeneratedImage> {
  const spec = option.mockup;
  if (!spec) throw new ImageGenerationError("invalid_request", "Option has no mockup to compose into.");
  const composed = composePreview({
    spec: spec as MockupSpec,
    art: decodeArt(await readFile(art.path)),
    widthCells: spec.widthCells ?? DEFAULT_MOCKUP_CELLS.widthCells,
    heightCells: spec.heightCells ?? DEFAULT_MOCKUP_CELLS.heightCells,
  });
  const now = options.now ?? Date.now;
  const id = (options.randomId ?? randomUUID)();
  const stem = `composed-${safePart(option.id, "option")}-${now()}-${safePart(id, "composed")}`;
  const directory = options.outputDir ?? join(options.cwd, ".pi", "generated-images");
  const path = join(directory, `${stem}.png`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path, composed.png, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ImageGenerationError("io_error", `Unable to save composed preview: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  return {
    path,
    mimeType: "image/png",
    provider: "composed",
    model: `deterministic-cell-renderer+${art.model ?? art.provider}`,
    prompt: art.prompt,
    byteCount: composed.png.length,
  };
}

/**
 * Resolve every option's requested image: a deterministic mockup is drawn
 * locally, a `generate` request goes to the configured provider, an option that
 * asks for both gets the two composed, and an existing image reference is never
 * overwritten.
 */
export async function generateReviewImages(
  review: NormalizedReview,
  options: ImageGeneratorOptions,
): Promise<GeneratedReviewImages> {
  const requested = review.stages.flatMap((stage) =>
    stage.options
      .filter((option) => option.generate !== undefined || option.mockup !== undefined)
      .map((option) => ({ stage, option })),
  );
  if (requested.length === 0) return { review, images: [] };

  const images: GeneratedImage[] = [];
  const generatedByKey = new Map<string, GeneratedImage>();
  for (const [index, item] of requested.entries()) {
    if (options.signal?.aborted) throw new ImageGenerationError("aborted", "Image generation was cancelled.");
    if (item.option.mockup !== undefined && item.option.generate !== undefined) {
      // Both are asked for: the provider supplies the art, the deterministic
      // renderer supplies the structure, and the two are composed into one
      // preview rather than one silently winning over the other.
      const request = effectiveGeneration(review, item.option);
      if (!request) continue;
      const provider = endpointFor(request.provider ?? DEFAULT_IMAGE_PROVIDER);
      const art = await requestImage(request, provider, request.model ?? DEFAULT_IMAGE_MODEL, options);
      const composed = await renderComposedMockup(item.option, art, options);
      images.push(composed);
      generatedByKey.set(`${item.stage.id}:${item.option.id}`, composed);
      options.onProgress?.({ completed: index + 1, total: requested.length, option: item.option, image: composed });
      continue;
    }
    if (item.option.mockup !== undefined) {
      const mockup = await renderOptionMockup(item.option, options);
      images.push(mockup);
      generatedByKey.set(`${item.stage.id}:${item.option.id}`, mockup);
      options.onProgress?.({ completed: index + 1, total: requested.length, option: item.option, image: mockup });
      continue;
    }
    const request = effectiveGeneration(review, item.option);
    if (!request) continue;
    const provider = endpointFor(request.provider ?? DEFAULT_IMAGE_PROVIDER);
    const model = request.model ?? DEFAULT_IMAGE_MODEL;
    const image = await requestImage(request, provider, model, options);
    images.push(image);
    generatedByKey.set(`${item.stage.id}:${item.option.id}`, image);
    options.onProgress?.({ completed: index + 1, total: requested.length, option: item.option, image });
  }

  const stages = review.stages.map((stage) => ({
    ...stage,
    options: stage.options.map((option) => {
      const image = generatedByKey.get(`${stage.id}:${option.id}`);
      if (!image) return option;
      return {
        ...option,
        image: { path: image.path, mimeType: image.mimeType, alt: option.image?.alt ?? `Generated preview for ${option.label}` },
        generate: undefined,
        mockup: undefined,
      };
    }),
  }));
  return { review: { ...review, stages }, images };
}
