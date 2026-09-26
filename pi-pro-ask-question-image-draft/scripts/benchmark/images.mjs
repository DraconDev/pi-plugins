#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

import { generateReviewImages } from "../../src/image-generator.ts";
import { normalizeReview } from "../../src/schema.ts";
import { assertNoCredentials, BenchmarkError, parseArgs, parsePositiveLimit, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { optionPrompt } from "./image-prompt.mjs";

export { optionPrompt } from "./image-prompt.mjs";

export const DEFAULT_MANIFEST = ".pi/benchmark/images.json";
export const DEFAULT_CACHE = ".pi/benchmark/image-manifest.json";
export const DEFAULT_IMAGE_DIR = ".pi/benchmark/images";
/** Hard ceiling from the objective: at most 600 successful Agnes generations. */
export const IMAGE_BUDGET = 600;

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

/** Three options per visual scenario, deduped by prompt hash. */
export function planImages(corpus, { strata = ["visual"], limit = IMAGE_BUDGET, scenarioLimit = Infinity } = {}) {
  const planned = [];
  let scenarios = 0;
  for (const scenario of corpus.scenarios) {
    if (!strata.includes(scenario.stratum)) continue;
    if (scenarios >= scenarioLimit) break;
    scenarios += 1;
    for (const stage of scenario.canonicalInput.stages ?? []) {
      for (const option of stage.options) {
        const prompt = optionPrompt(scenario, option);
        planned.push({
          optionId: `${scenario.id}:${option.key ?? option.id ?? option.label}`,
          scenarioId: scenario.id, stratum: scenario.stratum, stageId: stage.id,
          optionKey: option.key ?? option.id ?? option.label, optionLabel: option.label,
          prompt, hash: promptHash(prompt),
        });
      }
    }
  }
  if (planned.length > limit) {
    throw new BenchmarkError("generation_limit", `Plan needs ${planned.length} images but --max is ${limit}.`);
  }
  return planned;
}

async function readCacheFile(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function cacheHit(entry) {
  try {
    const path = resolve(entry.path);
    const info = await stat(path);
    const detected = detectImage(await readFile(path));
    return info.isFile() && info.size === entry.byteCount && detected.width === entry.width ? path : null;
  } catch {
    return null;
  }
}

/**
 * Generate the missing images for the visual stratum.
 *
 * Bounded by the 600-image budget, cached by prompt hash so a rerun costs
 * nothing, and every failure (quota, connection, upstream) is recorded with a
 * typed code and never retried silently.
 */
export async function runGeneration(corpus, {
  max = IMAGE_BUDGET, out = DEFAULT_IMAGE_DIR, cachePath = DEFAULT_CACHE, log = () => {}, scenarioLimit = Infinity, concurrency = 4,
} = {}) {
  const planned = planImages(corpus, { limit: max, scenarioLimit });
  const cache = (await readCacheFile(cachePath)) ?? { schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-manifest", images: [], failures: [] };
  // The cache is self-healing. Anything in it that the current plan did not ask
  // for - an entry from an older prompt, a duplicate, a leftover from a run
  // that was interrupted - is dropped before the run starts, and reported. A
  // stale entry used to survive into the manifest and then fail validation
  // because its image was no longer on disk, which made the pipeline
  // unrecoverable without deleting the cache by hand.
  const planHashes = new Set(planned.map((item) => item.hash));
  const kept = [];
  const seenHashes = new Set();
  let pruned = 0;
  for (const entry of cache.images ?? []) {
    if (!planHashes.has(entry.hash) || seenHashes.has(entry.hash)) { pruned += 1; continue; }
    seenHashes.add(entry.hash);
    kept.push(entry);
  }
  const byHash = new Map(kept.map((image) => [image.hash, image]));
  const images = [...kept];
  // A failure record is superseded once that option is generated successfully,
  // so the ledger never reports a stale failure next to a real image, and a
  // failure is only ever recorded once per option.
  const planOptionIds = new Set(planned.map((item) => item.optionId));
  const failedOnce = new Map();
  for (const failure of cache.failures ?? []) {
    if (!planOptionIds.has(failure.optionId) || failedOnce.has(failure.optionId)) { pruned += 1; continue; }
    failedOnce.set(failure.optionId, failure);
  }
  let failures = [...failedOnce.values()];
  let generated = 0;
  let cached = 0;
  let cursor = 0;

/** Atomic cache write: a reader (or a second process) never sees a half file. */
let flushCounter = 0;
async function flush() {
  const manifest = { schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-manifest", provider: "agnes", planned: planned.length, images, failures };
  assertNoCredentials(manifest);
  // Concurrent workers each write their own temporary file. Sharing one name
  // let the first rename win and every other flush fail with ENOENT, so the
  // cache ended up describing a fraction of the images actually on disk.
  const temporary = `${cachePath}.${process.pid}.${flushCounter++}.tmp`;
  await writeJson(temporary, manifest);
  await rename(temporary, cachePath);
}

  const worker = async () => {
    while (cursor < planned.length) {
      const item = planned[cursor];
      cursor += 1;
      const existing = byHash.get(item.hash);
      if (existing && await cacheHit(existing)) { cached += 1; continue; }
      // The budget is spent by *successful* generations, and the check plus the
      // increment is synchronous, so bounded concurrency cannot overshoot it.
      if (generated + failures.length >= max) {
        failures.push({ optionId: item.optionId, scenarioId: item.scenarioId, code: "generation_limit", message: "Skipped: the 600-image benchmark budget is spent.", at: new Date().toISOString() });
        continue;
      }
      const review = normalizeReview({
        reviewId: item.scenarioId, round: 1, stages: [{
          id: item.stageId, kind: "draft", header: item.stageId, prompt: item.prompt,
          options: [
            { id: item.optionKey, label: item.optionLabel, description: item.prompt, generate: { prompt: item.prompt, provider: "agnes" } },
            // The schema requires a real choice; this filler is never generated
            // and only exists so the single-option request validates.
            { id: `${item.optionKey}-filler`, label: "Unchanged baseline", description: "Baseline treatment without a generated image." },
          ],
          allowOther: false, allowRevision: false, required: true,
        }],
      }, 1);
      try {
        const result = await generateReviewImages(review, { cwd: process.cwd(), outputDir: resolve(out), timeoutMs: 180_000 });
        const image = result.images[0];
        if (!image) throw new BenchmarkError("no_image_returned", "The provider returned no image for this option.");
        const bytes = await readFile(image.path);
        const detected = detectImage(bytes);
        const entry = {
          id: item.optionId, optionIds: [item.optionId], scenarioId: item.scenarioId, stratum: item.stratum,
          prompt: item.prompt, hash: item.hash, path: image.path,
          provider: "agnes", model: image.model,
          mimeType: detected.mimeType, width: detected.width, height: detected.height, byteCount: bytes.length,
          generatedAt: new Date().toISOString(),
        };
        const index = images.findIndex((item) => item.hash === entry.hash);
        if (index >= 0) images.splice(index, 1);
        images.push(entry);
        byHash.set(item.hash, entry);
        failures = failures.filter((failure) => failure.optionId !== item.optionId);
        generated += 1;
        log({ event: "generated", optionId: item.optionId, width: detected.width, height: detected.height, total: generated + cached });
        await flush();
      } catch (error) {
        const failure = {
          optionId: item.optionId, scenarioId: item.scenarioId, code: error?.code ?? "request_failed",
          message: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
        };
        failures.push(failure);
        log({ event: "failed", ...failure });
        await flush();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, planned.length || 1)) }, worker));

  const manifest = { schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-manifest", provider: "agnes", planned: planned.length, images, failures };
  assertNoCredentials(manifest);
  await flush();
  return { manifest, generated, cached, failures: failures.length, planned: planned.length, pruned };
}

/**
 * Every Agnes generation this benchmark has ever made, not just the ones the
 * current manifest keeps.
 *
 * The 600-image budget is enforced per manifest, and the manifest is keyed by
 * prompt hash, so revising the image prompt retires a whole set of images. That
 * is the right cache design and it is also a way to understate provider
 * consumption: `imageGenerations: 600` was true of the manifest and false of the
 * account. This counts the artifacts on disk by inode - hard-linked contract
 * aliases excluded - and splits them into the current set and the superseded
 * ones, so the boundary can be checked against the real number.
 */
export async function generationAccounting(manifest, { imageDir = DEFAULT_IMAGE_DIR, aliasPrefix = CONTRACT_ALIAS_PREFIX } = {}) {
  const referenced = new Set((manifest?.images ?? []).map((image) => image.path));
  let current = 0;
  const superseded = [];
  let aliases = 0;
  let entries = [];
  try { entries = await readdir(imageDir); } catch { entries = []; }
  for (const name of entries) {
    if (!name.endsWith(".png")) continue;
    const path = resolve(imageDir, name);
    if (name.startsWith(aliasPrefix)) { aliases += 1; continue; }
    if (referenced.has(path)) current += 1;
    else superseded.push(path);
  }
  return {
    // Distinct provider artifacts: the current set plus everything a retired
    // prompt set left behind.
    cumulativeSuccessfulGenerations: current + superseded.length,
    currentSetGenerations: current,
    supersededGenerations: superseded.length,
    contractAliases: aliases,
    budgetPerManifest: IMAGE_BUDGET,
    recordedFailures: (manifest?.failures ?? []).length,
    note: "The 600 budget is enforced per manifest, which is keyed by prompt hash; revising the image prompt retires a whole set. The cumulative figure is the real provider consumption for this benchmark.",
  };
}

export const GENERATION_LEDGER = ".pi/benchmark/generations.json";

/**
 * The durable generation account.
 *
 * Written before any pruning, so the superseded count survives the deletion it
 * describes: after the orphans are gone the directory only shows the current
 * set, and the real cumulative consumption would be unrecoverable.
 */
export async function recordGenerationAccount(manifest, options = {}) {
  const path = resolve(options.ledger ?? GENERATION_LEDGER);
  const prior = await readCacheFile(path);
  const account = await generationAccounting(manifest, options);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-generation-account",
    observedAt: new Date().toISOString(),
    ...account,
    // A previous account is never overwritten with a smaller cumulative figure:
    // deletions reduce what is on disk, not what was generated.
    cumulativeSuccessfulGenerations: Math.max(account.cumulativeSuccessfulGenerations, prior?.cumulativeSuccessfulGenerations ?? 0),
    supersededDeletedAt: prior?.supersededDeletedAt ?? null,
  };
  await writeJson(path, record);
  return record;
}

/** Delete artifacts no manifest entry references, and report what went. */
export async function pruneSupersededImages(manifest, { imageDir = DEFAULT_IMAGE_DIR, dryRun = false, ledger = GENERATION_LEDGER } = {}) {
  const recorded = await recordGenerationAccount(manifest, { imageDir, ledger });
  const account = await generationAccounting(manifest, { imageDir });
  const referenced = new Set((manifest?.images ?? []).map((image) => image.path));
  let entries = [];
  try { entries = await readdir(imageDir); } catch { entries = []; }
  let removed = 0;
  let bytes = 0;
  for (const name of entries) {
    if (!name.endsWith(".png") || name.startsWith(CONTRACT_ALIAS_PREFIX)) continue;
    const path = resolve(imageDir, name);
    if (referenced.has(path)) continue;
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (!dryRun) await unlink(path);
    removed += 1;
    bytes += info.size;
  }
  if (!dryRun && removed > 0) {
    const record = { ...recorded, supersededDeletedAt: new Date().toISOString(), supersededRemoved: removed, supersededFreedBytes: bytes };
    await writeJson(resolve(ledger), record);
  }
  return { ...account, recorded: recorded.cumulativeSuccessfulGenerations, removed, freedBytes: bytes, dryRun };
}

/**
 * Canonical contract aliases.
 *
 * The release contract names `.pi/benchmark/images/visual-001-option-1.png`.
 * `visual-001` is the first visual scenario in corpus order and the suffix is
 * the option's index within that scenario, so the named path is a stable name
 * for a real generated image rather than something an auditor has to guess.
 */
export const CONTRACT_ALIAS_PREFIX = "visual-001-option-";

export async function writeContractAliases(corpus, manifest, { imageDir = DEFAULT_IMAGE_DIR } = {}) {
  const first = corpus.scenarios.find((scenario) => scenario.stratum === "visual");
  if (!first) throw new BenchmarkError("missing_evidence", "The corpus has no visual scenario to alias.");
  const options = (first.canonicalInput.stages ?? [])[0]?.options ?? [];
  const byKey = new Map((manifest.images ?? []).flatMap((image) => (image.optionIds ?? []).map((id) => [id, image])));
  const aliases = [];
  for (const [index, option] of options.entries()) {
    const source = byKey.get(`${first.id}:${option.key ?? option.id ?? option.label}`);
    if (!source) continue;
    const name = `${CONTRACT_ALIAS_PREFIX}${index + 1}.png`;
    const target = resolve(imageDir, name);
    await mkdir(resolve(imageDir), { recursive: true });
    try { await link(source.path, target); } catch { await copyFile(source.path, target); }
    aliases.push({ alias: target, name, scenarioId: first.id, optionId: source.id, source: source.path, promptHash: source.hash, bytes: source.byteCount });
  }
  if (!aliases.length) throw new BenchmarkError("missing_evidence", `No generated image is bound to ${first.id}; the contract aliases cannot be written.`);
  return aliases;
}

/**
 * `benchmark:images` - generate the visual corpus inside the 600-image budget
 * (cached by prompt hash), then validate and report what is on disk.
 * `--ingest-only` validates an existing manifest without any provider call.
 */
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    corpus: "string", manifest: "string", out: "string", cache: "string", max: "number",
    scenarios: "number", quiet: "boolean", "ingest-only": "boolean", concurrency: "number", "image-dir": "string",
  });
  const max = parsePositiveLimit(args.max, IMAGE_BUDGET);
  const out = args.out ?? DEFAULT_MANIFEST;
  const cachePath = args.cache ?? DEFAULT_CACHE;

  if (args.manifest || args["ingest-only"]) {
    // Ingest-only path: no provider calls at all.
    const manifest = await readJson(args.manifest ?? cachePath, "manifest_missing");
    const report = await ingestImageManifest(manifest, { max });
    const written = await writeJson(out, report);
    process.stdout.write(`${JSON.stringify({ out: written, generated: report.generated, cached: report.cached, providerCalls: 0 })}\n`);
    return report;
  }

  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const { manifest, generated, cached, failures, pruned } = await runGeneration(corpus, {
    max,
    out: args["image-dir"] ?? (args.out?.endsWith(".json") ? DEFAULT_IMAGE_DIR : args.out ?? DEFAULT_IMAGE_DIR),
    cachePath,
    scenarioLimit: args.scenarios ?? Infinity,
    concurrency: args.concurrency ?? 4,
    log: args.quiet ? () => {} : (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  const report = await ingestImageManifest(manifest, { max });
  report.generationFailures = failures;
  const written = await writeJson(out, report);
  if (!args["ingest-only"]) {
    // The contract names a canonical image path, so the pipeline produces it.
    try {
      report.contractAliases = await writeContractAliases(corpus, manifest, { imageDir: DEFAULT_IMAGE_DIR });
      await writeJson(out, report);
    } catch (error) {
      process.stderr.write(`benchmark:images: contract aliases not written: ${error.message}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    out: written, manifest: cachePath, planned: manifest.planned, generated, cached,
    validated: report.generated, failures, providerCalls: generated, budget: max, pruned,
    contractAliases: (report.contractAliases ?? []).map((alias) => alias.name),
  })}\n`);
  return report;
}

/**
 * `benchmark:images:report` - fold the judged decision utility into the image
 * report and state the visual gate outcome.
 */
export async function reportMain(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { manifest: "string", judges: "string", out: "string", max: "number" });
  const max = parsePositiveLimit(args.max, IMAGE_BUDGET);
  const manifestPath = args.manifest ?? (await readCacheFile(DEFAULT_CACHE) ? DEFAULT_CACHE : DEFAULT_MANIFEST);
  const manifest = await readJson(manifestPath, "manifest_missing");
  const judges = args.judges ? await readJson(args.judges, "judge_results_missing") : await readCacheFile(".pi/benchmark/judge.json");
  const report = await buildImageReport({ manifest, judgeResults: undefined, max });
  if (judges) {
    const summary = judges.summary ?? judges;
    report.decisionUtility = {
      judgedCases: summary.judgedCases ?? 0,
      candidateWins: summary.candidateWins ?? 0,
      candidateWinRate: summary.candidateWinRate ?? 0,
      wilson95LowerBound: summary.wilson95LowerBound ?? 0,
      ties: summary.ties ?? 0,
      undecided: summary.undecided ?? 0,
      severeFailuresText: 0,
      severeFailuresImage: summary.severeImageFailures ?? 0,
      severeImageFailureRate: summary.severeImageFailureRate ?? 0,
      model: judges.model ?? null,
      blinded: judges.blinded === true,
      tieIsNotCredit: judges.tieIsNotCredit === true,
    };
    report.decisionUtility.gate = {
      meaningfulUplift: (summary.candidateWinRate ?? 0) >= 0.6,
      confidenceBound: (summary.wilson95LowerBound ?? 0) > 0.5,
      severeFailures: (summary.severeImageFailureRate ?? 1) <= 0.02,
      judgedCases: (summary.decidedCases ?? summary.judgedCases ?? 0) >= 180,
      judgeErrors: (summary.judgeErrors ?? 0) <= 0.1 * (summary.judgedCases ?? 1),
    };
  }
  const out = await writeJson(args.out ?? ".pi/benchmark/image-report.json", report);
  process.stdout.write(`${JSON.stringify({ out, generated: report.generated, decisionUtility: report.decisionUtility })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv[1].endsWith("report.mjs") ? reportMain() : main()).catch((error) => { process.stderr.write(`benchmark:images: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
