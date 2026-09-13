/**
 * pi-agnes-tools
 *
 * The single Agnes AI plugin for pi: full model catalog (text, image, video)
 * for both endpoints PLUS image/video generation as callable tools.
 *
 *   Providers (`agnes` = international, `agnes-cn` = China): seed catalog +
 *   live /v1/models discovery + stream routing, so every model is selectable
 *   via /model and --model.
 *   Tools: `agnes_image` (default agnes-image-2.5-flash) and `agnes_video`
 *   (default agnes-video-2.5-flash) — no model switch needed.
 *
 * Auth: AGNES_API_KEY / AGNES_CN_API_KEY env, else /login-stored key.
 * Saves: .pi/generated-images/ and .pi/generated-videos/ (project-relative).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// typebox is provided to extensions by pi itself (bundled/virtual module).
import * as _typebox from "typebox";
const Type = _typebox.Type;

// pi-ai stream helpers (same import pi-agnes uses; resolved via pi's loader).
import {
  createAssistantMessageEventStream,
  openAICompletionsApi,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ENDPOINTS = {
  agnes: { baseUrl: "https://apihub.agnes-ai.com/v1", apiKeyEnv: "AGNES_API_KEY" },
  "agnes-cn": { baseUrl: "https://api.agnes-ai.cn/v1", apiKeyEnv: "AGNES_CN_API_KEY" },
};

const IMAGE_MODELS = new Set(["agnes-image-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.5-flash"]);
const VIDEO_MODELS = new Set(["agnes-video-v2.0", "agnes-video-2.5", "agnes-video-2.5-flash"]);
const DEFAULT_IMAGE_MODEL = "agnes-image-2.5-flash";
const DEFAULT_VIDEO_MODEL = "agnes-video-2.5-flash";

// Text/LLM models only — image/video generation goes through the tools +
// skill, not the /model selector.
const AGNES_SEED = [
  "agnes-2.5-flash",
  "agnes-2.5-pro",
  "agnes-2.5-pro-alpha",
  "agnes-2.0-flash",
  "agnes-3.0-flash",
];

function isTextModel(id) {
  return !id.startsWith("agnes-image-") && !id.startsWith("agnes-video-");
}

function isImageModel(id) {
  return IMAGE_MODELS.has(id) || id.startsWith("agnes-image-");
}

function isVideoModel(id) {
  return VIDEO_MODELS.has(id) || id.startsWith("agnes-video-");
}

function fileLink(p, label = p) {
  return "[" + label + "](" + pathToFileURL(p).href + ")";
}

function resolveApiKey(endpoint) {
  const cfg = ENDPOINTS[endpoint];
  // 1) Environment variable (fastest, always works)
  const envKey = process.env[cfg.apiKeyEnv];
  if (envKey) return envKey;
  // 2) /login-stored key in pi's auth store (same key pi-agnes uses)
  try {
    const authPath = join(homedir(), ".pi", "agent", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    const entry = auth[endpoint] || auth["agnes"];
    if (entry && entry.key) return entry.key;
  } catch {
    // ignore read/parse failures; fall through
  }
  throw new Error(
    "No API key found for " + cfg.apiKeyEnv + ". Set the " + cfg.apiKeyEnv + " environment variable, or run /login with the Agnes provider."
  );
}

function getEndpoint(endpoint) {
  const cfg = ENDPOINTS[endpoint];
  const apiKey = resolveApiKey(endpoint);
  return { baseUrl: cfg.baseUrl, apiKey, headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" } };
}

function checkImageModel(model) {
  if (!isImageModel(model)) {
    throw new Error("Unknown Agnes image model: " + model + ". Known models: " + [...IMAGE_MODELS].join(", "));
  }
}

function checkVideoModel(model) {
  if (!isVideoModel(model)) {
    throw new Error("Unknown Agnes video model: " + model + ". Known models: " + [...VIDEO_MODELS].join(", "));
  }
}

// ---------------------------------------------------------------------------
// Shared REST cores (used by both the tools and the standalone stream router)
// ---------------------------------------------------------------------------

async function saveImagePayload(image, modelId) {
  const directory = join(process.cwd(), ".pi", "generated-images");
  await mkdir(directory, { recursive: true });
  const mime = image.mime_type || "image/png";
  const ext =
    mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : mime.includes("gif") ? "gif" : "png";
  const filePath = join(directory, modelId + "-" + Date.now() + "." + ext);
  if (image.b64_json) {
    await writeFile(filePath, Buffer.from(image.b64_json, "base64"));
  } else if (image.url) {
    const imgRes = await fetch(image.url);
    if (!imgRes.ok) throw new Error("Unable to download image: HTTP " + imgRes.status);
    await writeFile(filePath, Buffer.from(await imgRes.arrayBuffer()));
  } else {
    throw new Error("Agnes image API returned no url or b64_json");
  }
  return { filePath, mimeType: mime, remoteUrl: image.url || null };
}

async function requestImage(baseUrl, apiKey, opts) {
  const body = { model: opts.model, prompt: opts.prompt };
  if (opts.response_format) body.response_format = opts.response_format;
  if (opts.images && opts.images.length > 0) body.image = opts.images;
  const response = await fetch(baseUrl + "/images/generations", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload && payload.error && payload.error.message) || "Agnes image API HTTP " + response.status);
  }
  const image = payload && payload.data && payload.data[0];
  if (!image) throw new Error("Agnes image API returned no image data");
  return saveImagePayload(image, opts.model);
}

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

async function requestVideo(baseUrl, apiKey, opts) {
  const body = { model: opts.model, prompt: opts.prompt };
  if (opts.num_frames) body.num_frames = opts.num_frames;
  if (opts.frame_rate) body.frame_rate = opts.frame_rate;
  const images = opts.images || [];
  if (images.length === 1) body.image = images[0];
  if (images.length > 1) body.extra_body = { image: images, mode: "keyframes" };

  const response = await fetch(baseUrl + "/videos", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const task = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((task && task.error && task.error.message) || "Agnes video API HTTP " + response.status);
  }
  const videoId = (task && (task.video_id || task.id || task.task_id)) || null;
  if (!videoId) throw new Error("Agnes video API returned no video_id");

  const result = task.status === "completed" ? task : await pollVideo(baseUrl, videoId, apiKey, opts.signal);
  const url = result && result.metadata && result.metadata.url;
  if (!url) throw new Error("Agnes video API returned no metadata.url");

  const directory = join(process.cwd(), ".pi", "generated-videos");
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, opts.model + "-" + Date.now() + ".mp4");
  const videoRes = await fetch(url);
  if (!videoRes.ok) throw new Error("Unable to download generated video: HTTP " + videoRes.status);
  await writeFile(filePath, Buffer.from(await videoRes.arrayBuffer()));
  return { filePath, remoteUrl: url };
}

// ---------------------------------------------------------------------------
// agnes_image / agnes_video tools (always registered — no provider conflict)
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
    description: "Which Agnes endpoint to use: agnes (international, apihub.agnes-ai.com) or agnes-cn (China, api.agnes-ai.cn). Default: agnes.",
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
  checkImageModel(rawModel);
  const { baseUrl, apiKey } = getEndpoint(endpointId);

  const saved = await requestImage(baseUrl, apiKey, {
    model: rawModel,
    prompt,
    images: params.images || [],
    response_format: params.response_format || "png",
  });

  const text = saved.remoteUrl
    ? "![](" + saved.remoteUrl + ")\n\nSaved local copy: " + fileLink(saved.filePath) + "\n\nImage URL may expire according to Agnes retention policy."
    : "Generated image saved to: " + fileLink(saved.filePath);

  return {
    content: [{ type: "text", text }],
    details: { filePath: saved.filePath, model: rawModel, endpoint: endpointId, remoteUrl: saved.remoteUrl },
  };
}

const videoParams = Type.Object({
  prompt: { type: "string", description: "Text prompt describing the video to generate." },
  model: {
    type: "string",
    description: "Agnes video model id. One of: " + [...VIDEO_MODELS].join(", ") + ". Default: " + DEFAULT_VIDEO_MODEL + ".",
  },
  endpoint: {
    type: "string",
    enum: ["agnes", "agnes-cn"],
    description: "Which Agnes endpoint to use: agnes (international, apihub.agnes-ai.com) or agnes-cn (China, api.agnes-ai.cn). Default: agnes.",
  },
  images: {
    type: "array",
    items: { type: "string" },
    description: "Optional reference image(s) as base64 data URIs. 1 image = image-to-video; >1 = keyframes mode.",
  },
  num_frames: { type: "integer", description: "Number of frames. Default: 121." },
  frame_rate: { type: "integer", description: "Frames per second. Default: 24." },
});

async function executeVideo(_toolCallId, params, signal) {
  const prompt = params.prompt;
  const rawModel = params.model || DEFAULT_VIDEO_MODEL;
  const endpointId = params.endpoint || "agnes";
  checkVideoModel(rawModel);
  const { baseUrl, apiKey } = getEndpoint(endpointId);

  const saved = await requestVideo(baseUrl, apiKey, {
    model: rawModel,
    prompt,
    images: params.images || [],
    num_frames: params.num_frames || 121,
    frame_rate: params.frame_rate || 24,
    signal,
  });

  const text = "Generated video saved to: " + fileLink(saved.filePath) + "\n\nVideo URL: " + saved.remoteUrl;
  return {
    content: [{ type: "text", text }],
    details: { filePath: saved.filePath, model: rawModel, endpoint: endpointId, remoteUrl: saved.remoteUrl },
  };
}

// ---------------------------------------------------------------------------
// Standalone provider fallback (only when pi-agnes is NOT installed).
// Mirrors pi-agnes: seed catalog + /v1/models discovery + stream routing,
// so /model selection works out of the box without pi-agnes.
// ---------------------------------------------------------------------------

function toModelConfig(id) {
  const limits =
    id.startsWith("agnes-2.5") || id.startsWith("agnes-3")
      ? { contextWindow: 1048576, maxTokens: 65536 }
      : id.startsWith("agnes-2.0")
        ? { contextWindow: 1048576, maxTokens: 32768 }
        : { contextWindow: 131072, maxTokens: 32768 };
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limits,
  };
}

async function fetchStandaloneModels(baseUrl, apiKey, signal) {
  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;
  const res = await fetch(baseUrl + "/models", { headers, redirect: "follow", signal });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
  const payload = await res.json().catch(() => null);
  const data = payload && Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data
    .filter((m) => m && m.id && isTextModel(m.id))
    .map((m) => toModelConfig(m.id));
}

function makeRefreshModels(baseUrl, apiKeyEnv, providerId) {
  return async ({ signal, stored, publish, allowNetwork, credential }) => {
    const cached = stored && Array.isArray(stored.models) ? stored.models : undefined;
    if (!allowNetwork || (signal && signal.aborted)) return cached;
    const apiKey = credential && credential.type === "api_key" ? credential.key : process.env[apiKeyEnv];
    let models;
    try {
      models = await fetchStandaloneModels(baseUrl, apiKey, signal);
    } catch (error) {
      if (cached) return cached;
      throw error;
    }
    if (models.length > 0) {
      await publish({ persist: { provider: providerId, models } });
      return models;
    }
    return cached;
  };
}

function latestUserMessage(context) {
  const messages = context && Array.isArray(context.messages) ? context.messages : [];
  return [...messages].reverse().find((m) => m && m.role === "user");
}

function extractPrompt(context) {
  const user = latestUserMessage(context);
  if (!user) return { prompt: "", images: [] };
  if (typeof user.content === "string") return { prompt: user.content, images: [] };
  return {
    prompt: user.content
      .filter((part) => part && part.type === "text")
      .map((part) => part.text || "")
      .join("\n"),
    images: user.content.filter((part) => part && part.type === "image"),
  };
}

function pushDone(stream, output, text) {
  output.content.push({ type: "text", text });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  output.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

function pushError(stream, output, error, signal) {
  output.stopReason = signal && signal.aborted ? "aborted" : "error";
  output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: output.stopReason, error: output });
  stream.end();
}

function newOutput(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function streamStandaloneImage(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = newOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const extracted = extractPrompt(context);
      if (!extracted.prompt) throw new Error("Image generation requires a text prompt");
      const endpointId = model.provider === "agnes-cn" ? "agnes-cn" : "agnes";
      const { baseUrl, apiKey } = getEndpoint(endpointId);
      const saved = await requestImage(baseUrl, apiKey, {
        model: model.id,
        prompt: extracted.prompt,
        images: extracted.images.map((img) => "data:" + img.mimeType + ";base64," + img.data),
        response_format: "png",
        signal: options && options.signal,
      });
      const text = saved.remoteUrl
        ? "![](" + saved.remoteUrl + ")\n\nSaved local copy: " + fileLink(saved.filePath) + "\n\nImage URL may expire according to Agnes retention policy."
        : "Generated image saved to: " + fileLink(saved.filePath);
      pushDone(stream, output, text);
    } catch (error) {
      pushError(stream, output, error, options && options.signal);
    }
  })();
  return stream;
}

function streamStandaloneVideo(model, context, options) {
  const stream = createAssistantMessageEventStream();
  const output = newOutput(model);
  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const extracted = extractPrompt(context);
      if (!extracted.prompt) throw new Error("Video generation requires a text prompt");
      const endpointId = model.provider === "agnes-cn" ? "agnes-cn" : "agnes";
      const { baseUrl, apiKey } = getEndpoint(endpointId);
      const saved = await requestVideo(baseUrl, apiKey, {
        model: model.id,
        prompt: extracted.prompt,
        images: extracted.images.map((img) => "data:" + img.mimeType + ";base64," + img.data),
        num_frames: 121,
        frame_rate: 24,
        signal: options && options.signal,
      });
      pushDone(stream, output, "Generated video saved to: " + fileLink(saved.filePath) + "\n\nVideo URL: " + saved.remoteUrl);
    } catch (error) {
      pushError(stream, output, error, options && options.signal);
    }
  })();
  return stream;
}

function streamStandalone(model, context, options) {
  if (isVideoModel(model.id)) return streamStandaloneVideo(model, context, options);
  if (isImageModel(model.id)) return streamStandaloneImage(model, context, options);
  return openAICompletionsApi().streamSimple(model, context, options);
}

function debugLog(msg) {
  if (process.env.PI_AGNES_TOOLS_DEBUG) {
    try { console.error("[pi-agnes-tools] " + msg); } catch { /* ignore */ }
  }
}

function registerAgnesProviders(pi) {
  const defs = [
    { id: "agnes", name: "Agnes AI", baseUrl: ENDPOINTS.agnes.baseUrl, apiKeyEnv: "AGNES_API_KEY" },
    { id: "agnes-cn", name: "Agnes AI (CN)", baseUrl: ENDPOINTS["agnes-cn"].baseUrl, apiKeyEnv: "AGNES_CN_API_KEY" },
  ];
  for (const def of defs) {
    // Omit apiKey when the env var is absent so /login can supply the key —
    // same convention pi-agnes uses.
    const apiKeyRef = process.env[def.apiKeyEnv] ? "$" + def.apiKeyEnv : undefined;
    pi.registerProvider(def.id, {
      name: def.name,
      baseUrl: def.baseUrl,
      ...(apiKeyRef ? { apiKey: apiKeyRef } : {}),
      api: "openai-completions",
      streamSimple: streamStandalone,
      models: AGNES_SEED.map((id) => toModelConfig(id)),
      refreshModels: makeRefreshModels(def.baseUrl, def.apiKeyEnv, def.id),
    });
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi) {
  // Tools are always safe: unique names, no provider overlap.
  pi.registerTool({
    name: "agnes_image",
    label: "Agnes Image",
    description:
      "Generate an image via the Agnes AI API (no model switch needed). " +
      "Saves a local copy under .pi/generated-images/ and returns the saved path plus the (possibly expiring) remote URL. " +
      "endpoint: agnes = international (apihub.agnes-ai.com, default), agnes-cn = China (api.agnes-ai.cn). " +
      "Auth: AGNES_API_KEY or AGNES_CN_API_KEY env, else the /login-stored Agnes key.",
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
      "endpoint: agnes = international (default), agnes-cn = China. " +
      "Auth: AGNES_API_KEY or AGNES_CN_API_KEY env, else the /login-stored Agnes key.",
    parameters: videoParams,
    executionMode: "sequential",
    execute: executeVideo,
  });

  // Providers: this plugin owns `agnes` (international) and `agnes-cn`
  // (China) outright — seed catalog + live discovery + stream routing — so
  // every text, image and video model is selectable via /model and --model.
  try {
    registerAgnesProviders(pi);
  } catch (error) {
    debugLog("provider registration failed: " + (error instanceof Error ? error.message : String(error)));
  }
}
