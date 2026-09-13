/**
 * pi-agnes-tools
 *
 * Exposes Agnes AI image/video generation as callable tools, so you don't
 * have to switch models just to generate media.
 *
 *   • agnes_image  — POST /v1/images/generations (agnes-image-2.1-flash etc.)
 *   • agnes_video  — POST /v1/videos + poll until done (agnes-video-2.5-flash etc.)
 *
 * Auth: reuses AGNES_API_KEY / AGNES_CN_API_KEY (same env vars as pi-agnes).
 * Saves: .pi/generated-images/ and .pi/generated-videos/ (project-relative).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// typebox: prefer the pi-bundled copy when available (compiled binary / SEA),
// fall back to a bare import when running as plain ESM (dev / jiti).
import * as _typebox from "typebox";
const Type = _typebox.Type;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  agnes: { baseUrl: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY", authKey: "agnes" },
  "agnes-cn": { baseUrl: "https://api.agnes-ai.cn/v1", apiKeyEnv: "AGNES_CN_API_KEY", authKey: "agnes-cn" },
};

const IMAGE_MODELS = new Set(["agnes-image-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.5-flash"]);
const VIDEO_MODELS = new Set(["agnes-video-v2.0", "agnes-video-2.5", "agnes-video-2.5-flash"]);
const DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash";
const DEFAULT_VIDEO_MODEL = "agnes-video-2.5-flash";

const ALL_AGNES_MODELS = [
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
  "agnes-2.0-flash",
  "agnes-3.0-flash",
  "agnes-image-2.0-flash",
  "agnes-image-2.1-flash",
  "agnes-image-2.5-flash",
  "agnes-video-v2.0",
  "agnes-video-2.5",
  "agnes-video-2.5-flash",
];

function fileLink(p, label = p) {
  return "[" + label + "](" + pathToFileURL(p).href + ")";
}

function resolveApiKey(endpoint) {
  const cfg = ENDPOINTS[endpoint];
  // 1) Environment variable (fastest, always works)
  const envKey = process.env[cfg.apiKeyEnv];
  if (envKey) return envKey;
  // 2) /login-stored key in pi's auth store
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    // Primary key: 'agnes' for both endpoints (pi-agnes registers one key per
    // provider id, and the CN endpoint uses the same account/key in most setups).
    const entry = auth[cfg.authKey] || auth["agnes"];
    if (entry && entry.key) return entry.key;
  } catch {
    // ignore read/parse failures; fall through
  }
  throw new Error(
    "No API key found for " + cfg.apiKeyEnv + ". Set the " + cfg.apiKeyEnv + " environment variable, or run /login with the pi-agnes provider."
  );
}

function getEndpoint(endpoint) {
  const cfg = ENDPOINTS[endpoint];
  const apiKey = resolveApiKey(endpoint);
  return { baseUrl: cfg.baseUrl, apiKey, headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" } };
}

function checkImageModel(model) {
  if (!IMAGE_MODELS.has(model) && !model.startsWith("agnes-image-")) {
    throw new Error("Unknown Agnes image model: " + model + ". Known models: " + [...IMAGE_MODELS].join(", "));
  }
}

function checkVideoModel(model) {
  if (!VIDEO_MODELS.has(model) && !model.startsWith("agnes-video-")) {
    throw new Error("Unknown Agnes video model: " + model + ". Known models: " + [...VIDEO_MODELS].join(", "));
  }
}

// ---------------------------------------------------------------------------
// agnes_image tool
// ---------------------------------------------------------------------------

const imageParams = Type.Object({
  prompt: { type: "string", description: "Text prompt describing the image to generate." },
  model: {
    type: "string",
    description: "Agnes image model id. One of: " + [...IMAGE_MODELS].join(", ") + ". Default: " + DEFAULT_IMAGE_MODEL + ".",
  },
  endpoint: {
    type: "string",
    enum: ["agnes", "agnes-cn"],
    description: "Which Agnes endpoint to use. Default: agnes (apihub.agnes-ai.com).",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description:
      "Optional list of base64-encoded image data URIs (data:<mime>;base64,<data>) to use as reference/conditioning images.",
  },
  response_format: {
    type: "string",
    description: "Response image format. Default: png.",
  },
});

async function executeImage(_toolCallId, params) {
  const prompt = params.prompt;
  const rawModel = params.model || DEFAULT_IMAGE_MODEL;
  const endpointId = params.endpoint || "agnes";
  const images = params.images || [];
  const response_format = params.response_format || "png";

  checkImageModel(rawModel);
  const { baseUrl, headers } = getEndpoint(endpointId);

  const body = { model: rawModel, prompt, response_format };
  if (images.length > 0) {
    body.image = images;
  }

  const response = await fetch(baseUrl + "/images/generations", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || "Agnes image API HTTP " + response.status);
  }
  const image = payload && payload.data && payload.data[0];
  if (!image) throw new Error("Agnes image API returned no image data");

  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mime = image.mime_type || "image/png";
  const ext =
    mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
  const filePath = join(directory, rawModel + "-" + Date.now() + "." + ext);
  if (image.b64_json) {
    await writeFile(filePath, Buffer.from(image.b64_json, "base64"));
  } else if (image.url) {
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) throw new Error("Unable to download image: HTTP " + imgRes.status);
    await writeFile(filePath, Buffer.from(await imgRes.arrayBuffer()));
  } else {
    throw new Error("Agnes image API returned no url or b64_json");
  }

  const text = image.url
    ? "![](" + image.url + ")\n\nSaved local copy: " + fileLink(filePath) + "\n\nImage URL may expire according to Agnes retention policy."
    : "Generated image saved to: " + fileLink(filePath);

  return {
    content: [{ type: "text", text }],
    details: { filePath, model: rawModel, endpoint: endpointId, remoteUrl: image.url || null },
  };
}

// ---------------------------------------------------------------------------
// agnes_video tool
// ---------------------------------------------------------------------------

const videoParams = Type.Object({
  prompt: { type: "string", description: "Text prompt describing the video to generate." },
  model: {
    type: "string",
    description: "Agnes video model id. One of: " + [...VIDEO_MODELS].join(", ") + ". Default: " + DEFAULT_VIDEO_MODEL + ".",
  },
  endpoint: {
    type: "string",
    enum: ["agnes", "agnes-cn"],
    description: "Which Agnes endpoint to use. Default: agnes (apihub.agnes-ai.com).",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description: "Optional reference image(s) as base64 data URIs. 1 image = image-to-video; >1 = keyframes mode.",
  },
  num_frames: { type: "integer", description: "Number of frames. Default: 121." },
  frame_rate: { type: "integer", description: "Frames per second. Default: 24." },
});

async function pollVideo(baseUrl, videoId, apiKey, signal) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error("Video generation aborted");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("Video generation aborted"));
          },
          { once: true }
        );
      }
    });
    const apiRoot = baseUrl.replace(/\/v1\/?$/, "");
    const response = await fetch(apiRoot + "/agnesapi?video_id=" + encodeURIComponent(videoId), {
      headers: { Authorization: "Bearer " + apiKey },
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error((payload && payload.error && payload.error.message) || "Agnes video status HTTP " + response.status);
    }
    if (payload.status === "completed") return payload;
    if (payload.status === "failed") {
      throw new Error((payload && payload.error && payload.error.message) || "Agnes video generation failed");
    }
  }
  throw new Error("Agnes video generation timed out after 30 minutes");
}

async function executeVideo(_toolCallId, params, signal) {
  const prompt = params.prompt;
  const rawModel = params.model || DEFAULT_VIDEO_MODEL;
  const endpointId = params.endpoint || "agnes";
  const images = params.images || [];
  const num_frames = params.num_frames || 121;
  const frame_rate = params.frame_rate || 24;

  checkVideoModel(rawModel);
  const { baseUrl, apiKey, headers } = getEndpoint(endpointId);

  const body = { model: rawModel, prompt, num_frames, frame_rate };
  if (images.length === 1) body.image = images[0];
  if (images.length > 1) body.extra_body = { image: images, mode: "keyframes" };

  const response = await fetch(baseUrl + "/videos", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  const task = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((task && task.error && task.error.message) || "Agnes video API HTTP " + response.status);
  }
  const videoId = (task && (task.video_id || task.id || task.task_id)) || null;
  if (!videoId) throw new Error("Agnes video API returned no video_id");

  const result = task.status === "completed" ? task : await pollVideo(baseUrl, videoId, apiKey, signal);
  const url = result && result.metadata && result.metadata.url;
  if (!url) throw new Error("Agnes video API returned no metadata.url");

  const directory = join(process.cwd(), ".pi", "generated-videos");
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, rawModel + "-" + Date.now() + ".mp4");
  const videoRes = await fetch(url);
  if (!videoRes.ok) throw new Error("Unable to download generated video: HTTP " + videoRes.status);
  await writeFile(filePath, Buffer.from(await videoRes.arrayBuffer()));

  const text = "Generated video saved to: " + fileLink(filePath) + "\n\nVideo URL: " + url;
  return {
    content: [{ type: "text", text }],
    details: { filePath, model: rawModel, endpoint: endpointId, remoteUrl: url },
  };
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi) {
  // Register the full Agnes model catalog so all models (text, image, video)
  // are selectable via /model and --model. pi-agnes does the same; this makes
  // pi-agnes-tools work standalone.
  pi.registerProvider("agnes", {
    name: "Agnes AI",
    baseUrl: ENDPOINTS.agnes.baseUrl,
    apiKey: "$AGNES_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: ALL_AGNES_MODELS.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
    })),
  });

  pi.registerProvider("agnes-cn", {
    name: "Agnes AI (CN)",
    baseUrl: ENDPOINTS["agnes-cn"].baseUrl,
    apiKey: "$AGNES_CN_API_KEY",
    api: "openai-completions",
    authHeader: true,
    models: ALL_AGNES_MODELS.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
    })),
  });

  pi.registerTool({
    name: "agnes_image",
    label: "Agnes Image",
    description:
      "Generate an image via the Agnes AI API (no model switch needed). " +
      "Saves a local copy under .pi/generated-images/ and returns the saved path plus the (possibly expiring) remote URL. " +
      "Auth: AGNES_API_KEY (default endpoint) or AGNES_CN_API_KEY (endpoint=agnes-cn).",
    parameters: imageParams,
    executionMode: "parallel",
    execute: executeImage,
  });

  pi.registerTool({
    name: "agnes_video",
    label: "Agnes Video",
    description:
      "Generate a video via the Agnes AI API (no model switch needed). " +
      "Async: creates a task, polls every 5s until done (up to 30 min), then downloads the .mp4 to .pi/generated-videos/. " +
      "Supports image-to-video (1 reference image) and keyframes mode (>1 image). " +
      "Auth: AGNES_API_KEY (default endpoint) or AGNES_CN_API_KEY (endpoint=agnes-cn).",
    parameters: videoParams,
    executionMode: "sequential",
    execute: executeVideo,
  });
}
