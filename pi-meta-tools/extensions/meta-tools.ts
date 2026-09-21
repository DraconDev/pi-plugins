/**
 * pi-meta-tools
 *
 * Tools-only pi plugin for Meta media generation (Muse Image). No provider
 * registration, no new login: auth reuses pi's stored Meta credential
 * (the minted Model API key from /login meta) or MODEL_API_KEY env.
 *
 *   Tools: `meta_image` (text-to-image) and `meta_image_edit`
 *   (image edit / multi-reference composition, model muse-image-1.0).
 *
 * Saves: .pi/generated-images/ (project-relative).
 */
import {
  DEFAULT_MODEL,
  buildImagePayload,
  buildToolSchemas,
  errorHint,
  formatSavedImages,
  parseImageResponse,
  prepareImageUri,
  resolveApiKey,
  resolveBaseUrl,
  saveImageItem,
} from "./meta-image-lib.js";

// typebox is provided to extensions by pi itself (bundled/virtual module).
import * as _typebox from "typebox";
const Type = _typebox.Type;

// ---------------------------------------------------------------------------
// Shared REST core
// ---------------------------------------------------------------------------

async function requestImages(path: string, payload: Record<string, unknown>, signal?: AbortSignal) {
  const baseUrl = resolveBaseUrl();
  const apiKey = resolveApiKey();
  const response = await fetch(baseUrl + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const msg =
      (body && body.error && (body.error.message || body.error)) || "Meta image API HTTP " + response.status;
    throw new Error(String(msg) + errorHint(response.status, String(msg)));
  }
  return body;
}

async function generateAndSave(path: string, payload: Record<string, unknown>, outputFormat: string, signal?: AbortSignal) {
  const body = await requestImages(path, payload, signal);
  const items = parseImageResponse(body);
  const model = String(payload["model"] || DEFAULT_MODEL);
  const saved = [];
  for (let i = 0; i < items.length; i++) {
    saved.push(await saveImageItem(items[i], { model, index: i + 1, outputFormat, signal }));
  }
  return { text: formatSavedImages(saved), saved };
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const { imageParams, editParams } = buildToolSchemas(Type);

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function executeImage(_toolCallId: string, params: Record<string, any>, signal?: AbortSignal) {
  const outputFormat = params.output_format || "png";
  const payload = buildImagePayload({
    prompt: params.prompt,
    model: params.model,
    n: params.n,
    size: params.size,
    output_format: outputFormat,
    reasoning_strength: params.reasoning_strength,
    enable_image_search: params.enable_image_search,
    enable_web_search: params.enable_web_search,
    enable_shell: params.enable_shell,
  });
  const { text, saved } = await generateAndSave("/images/generations", payload, outputFormat, signal);
  return {
    content: [{ type: "text", text }],
    details: { files: saved.map((s) => s.filePath), model: payload["model"], remoteUrls: saved.map((s) => s.remoteUrl) },
  };
}

async function executeEdit(_toolCallId: string, params: Record<string, any>, signal?: AbortSignal) {
  const refs: string[] = params.images || [];
  if (!Array.isArray(refs) || refs.length === 0) {
    throw new Error("meta_image_edit requires at least one reference image (local path, URL, or data URI).");
  }
  const outputFormat = params.output_format || "png";
  const payload = buildImagePayload({
    prompt: params.prompt,
    model: params.model,
    n: params.n,
    size: params.size,
    output_format: outputFormat,
    reasoning_strength: params.reasoning_strength,
    enable_image_search: params.enable_image_search,
    enable_web_search: params.enable_web_search,
    enable_shell: params.enable_shell,
    images: refs.map((r) => prepareImageUri(String(r))),
  });
  const { text, saved } = await generateAndSave("/images/edits", payload, outputFormat, signal);
  return {
    content: [{ type: "text", text }],
    details: { files: saved.map((s) => s.filePath), model: payload["model"], remoteUrls: saved.map((s) => s.remoteUrl) },
  };
}

// ---------------------------------------------------------------------------
// Extension entry (tools only — no provider, no login)
// ---------------------------------------------------------------------------

export default function (pi: any) {
  pi.registerTool({
    name: "meta_image",
    label: "Meta Image",
    description:
      "Generate images via Meta Muse Image (model " +
      DEFAULT_MODEL +
      ", no model switch needed). Agentic: uses search/code tools and self-refinement. " +
      "Saves local copies under .pi/generated-images/ and returns saved paths plus remote URLs. " +
      'size is an aspect hint like "1024x1024". ' +
      "Auth: pi's stored Meta credential (/login meta) or MODEL_API_KEY env.",
    parameters: imageParams,
    executionMode: "parallel",
    execute: executeImage,
  });

  pi.registerTool({
    name: "meta_image_edit",
    label: "Meta Image Edit",
    description:
      "Edit or compose images via Meta Muse Image (" +
      DEFAULT_MODEL +
      "). Pass 1+ reference images (local paths, URLs, or data URIs); the prompt describes the edit or how to combine them. " +
      "Saves local copies under .pi/generated-images/. " +
      "Auth: pi's stored Meta credential (/login meta) or MODEL_API_KEY env.",
    parameters: editParams,
    executionMode: "parallel",
    execute: executeEdit,
  });
}
