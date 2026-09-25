#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { assertNoCredentials, BenchmarkError, parseArgs, parsePositiveLimit, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";

export const DEFAULT_MANIFEST = ".pi/benchmark/images.json";

export function promptHash(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new BenchmarkError("invalid_manifest", "Image manifest prompts must be non-empty strings.");
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function dimensionsPng(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(16) < 1 || bytes.readUInt32BE(20) < 1) throw new BenchmarkError("invalid_image", "PNG dimensions are invalid.");
  return { mimeType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
function dimensionsGif(bytes) {
  if (bytes.length < 10) throw new BenchmarkError("invalid_image", "GIF dimensions are invalid.");
  return { mimeType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}
function dimensionsJpeg(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (offset + 9 >= bytes.length) break;
      return { mimeType: "image/jpeg", height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    if (offset + 4 > bytes.length) break;
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  throw new BenchmarkError("invalid_image", "JPEG dimensions could not be decoded.");
}
function dimensionsWebp(bytes) {
  if (bytes.length < 30) throw new BenchmarkError("invalid_image", "WebP dimensions are invalid.");
  const kind = bytes.subarray(12, 16).toString("ascii");
  if (kind === "VP8X") return { mimeType: "image/webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
  if (kind === "VP8 ") return { mimeType: "image/webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = bytes.readUInt32LE(21);
    return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  throw new BenchmarkError("invalid_image", "Unsupported WebP variant.");
}

export function detectImage(bytes) {
  if (bytes.length < 12 || bytes.length > 32 * 1024 * 1024) throw new BenchmarkError("invalid_image", "Image is empty or exceeds 32 MiB.");
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return dimensionsPng(bytes);
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return dimensionsGif(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return dimensionsJpeg(bytes);
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return dimensionsWebp(bytes);
  throw new BenchmarkError("invalid_image", "Local file does not have a supported PNG, JPEG, GIF, or WebP signature.");
}

export async function validateImageEntry(entry, root = process.cwd()) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new BenchmarkError("invalid_manifest", "Every image manifest entry must be an object.");
  for (const field of ["id", "prompt", "path", "provider", "model"]) if (typeof entry[field] !== "string" || !entry[field]) throw new BenchmarkError("invalid_manifest", `Image entry ${field} must be a non-empty string.`);
  if (entry.provider !== "agnes") throw new BenchmarkError("invalid_manifest", `Image ${entry.id} must identify provider agnes.`);
  if (entry.hash !== promptHash(entry.prompt)) throw new BenchmarkError("hash_mismatch", `Image ${entry.id} has an invalid prompt hash.`);
  const path = resolve(root, entry.path);
  if (!path.startsWith(`${resolve(root)}${process.platform === "win32" ? "\\" : "/"}`) && path !== resolve(root)) throw new BenchmarkError("invalid_path", `Image ${entry.id} escapes the benchmark root.`);
  let info, bytes;
  try { info = await stat(path); bytes = await readFile(path); } catch (cause) { throw new BenchmarkError("image_missing", `Image ${entry.id} is missing at ${path}.`, { cause }); }
  if (!info.isFile()) throw new BenchmarkError("invalid_image", `Image ${entry.id} is not a regular file.`);
  const detected = detectImage(bytes);
  if (entry.mimeType !== detected.mimeType || entry.width !== detected.width || entry.height !== detected.height || entry.byteCount !== bytes.length) {
    throw new BenchmarkError("image_metadata_mismatch", `Image ${entry.id} metadata does not match its local bytes.`);
  }
  return { ...entry, absolutePath: path, byteCount: bytes.length, ...detected };
}

export async function ingestImageManifest(manifest, { root = process.cwd(), max = 600 } = {}) {
  assertNoCredentials(manifest);
  if (manifest?.schemaVersion !== SCHEMA_VERSION || manifest?.kind !== "benchmark-image-manifest" || !Array.isArray(manifest.images)) throw new BenchmarkError("invalid_manifest", "Unsupported image manifest schema.");
  if (!Number.isInteger(max) || max < 0 || max > 600) throw new BenchmarkError("invalid_limit", "--max must be an integer from 0 through 600.");
  const seenIds = new Set(), byHash = new Map(), validated = [];
  for (const entry of manifest.images) {
    if (seenIds.has(entry?.id)) throw new BenchmarkError("duplicate_id", `Duplicate image id: ${entry?.id}`);
    seenIds.add(entry?.id);
    const item = await validateImageEntry(entry, root);
    const prior = byHash.get(item.hash);
    if (prior) { if (prior.absolutePath !== item.absolutePath) throw new BenchmarkError("cache_conflict", `Prompt hash ${item.hash} maps to multiple local files.`); continue; }
    byHash.set(item.hash, item);
    validated.push(item);
    if (validated.length > max) throw new BenchmarkError("generation_limit", `Image manifest exceeds --max ${max} successful Agnes generations.`);
  }
  return {
    schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-report", sourceManifest: manifest.source ?? null,
    provider: "agnes", requestedLimit: max, generated: validated.length, cached: manifest.images.length - validated.length,
    severeFailures: 0, images: validated.map(({ absolutePath, ...item }) => item),
    decisionUtility: null,
  };
}

export async function buildImageReport({ manifest, judgeResults, max = 600, root = process.cwd() }) {
  const report = await ingestImageManifest(manifest, { root, max });
  if (judgeResults !== undefined) {
    if (!Array.isArray(judgeResults) || judgeResults.some((item) => !item || typeof item.textUtility !== "number" || typeof item.imageUtility !== "number")) throw new BenchmarkError("invalid_judge_results", "Judge results require numeric textUtility and imageUtility fields.");
    const n = judgeResults.length;
    report.decisionUtility = {
      judgedCases: n,
      meanTextUtility: n ? judgeResults.reduce((sum, item) => sum + item.textUtility, 0) / n : 0,
      meanImageUtility: n ? judgeResults.reduce((sum, item) => sum + item.imageUtility, 0) / n : 0,
      uplift: n ? judgeResults.reduce((sum, item) => sum + item.imageUtility - item.textUtility, 0) / n : 0,
      severeFailuresText: judgeResults.filter((item) => item.severeFailure === "text" || item.severeFailure === "both").length,
      severeFailuresImage: judgeResults.filter((item) => item.severeFailure === "image" || item.severeFailure === "both").length,
    };
  }
  assertNoCredentials(report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { manifest: "string", out: "string", max: "number" });
  const max = parsePositiveLimit(args.max, 600);
  if (!args.manifest) throw new BenchmarkError("provider_calls_disabled", "Image generation is disabled in this implementation pass; supply a real --manifest from an authorized Agnes run.");
  const manifest = await readJson(args.manifest, "manifest_missing");
  const report = await ingestImageManifest(manifest, { max });
  const out = await writeJson(args.out ?? DEFAULT_MANIFEST, report);
  process.stdout.write(`${JSON.stringify({ out, generated: report.generated, cached: report.cached })}\n`);
}

export async function reportMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { manifest: "string", judges: "string", out: "string", max: "number" });
  const manifest = await readJson(args.manifest ?? DEFAULT_MANIFEST, "manifest_missing");
  const judges = args.judges ? await readJson(args.judges, "judge_results_missing") : undefined;
  const report = await buildImageReport({ manifest, judgeResults: judges, max: parsePositiveLimit(args.max, 600) });
  const out = await writeJson(args.out ?? ".pi/benchmark/image-report.json", report);
  process.stdout.write(`${JSON.stringify({ out, generated: report.generated, decisionUtility: report.decisionUtility })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv[1].endsWith("report.mjs") ? reportMain() : main()).catch((error) => { process.stderr.write(`benchmark:images: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
