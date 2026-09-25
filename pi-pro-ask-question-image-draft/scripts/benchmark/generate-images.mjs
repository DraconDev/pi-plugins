#!/usr/bin/env node
/**
 * Agnes image generation for the visual stratum.
 *
 * Bound: at most `--max` (default and hard cap 600) successful generations for
 * the whole benchmark, cached by prompt hash so a rerun costs nothing. Quota,
 * connection, and deadline failures are recorded and never retried silently.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { detectImage, promptHash } from "./images.mjs";
import { assertNoCredentials, BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { generateReviewImages } from "../../src/image-generator.ts";
import { normalizeReview } from "../../src/schema.ts";

export const DEFAULT_IMAGE_OUT = ".pi/benchmark/images";
const HARD_CAP = 600;

export function optionPrompt(scenario, option) {
  const concept = scenario.visualPrompt?.prompt?.trim();
  if (!concept) throw new BenchmarkError("missing_prompt", `${scenario.id} has no visual prompt.`);
  return [
    concept,
    `Treatment: ${option.label}.`,
    option.description ? `Direction: ${option.description}` : "",
    "Terminal-safe product mockup, high contrast, no photographic noise, legible at 80x24 characters.",
  ].filter(Boolean).join(" ");
}

export function planImages(corpus, { strata = ["visual"], limit = HARD_CAP, scenarioLimit = Infinity } = {}) {
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

async function readCache(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

export async function runGeneration(corpus, {
  max = HARD_CAP, out = DEFAULT_IMAGE_OUT, cachePath = ".pi/benchmark/image-manifest.json", log = () => {}, scenarioLimit = Infinity,
} = {}) {
  const planned = planImages(corpus, { limit: max, scenarioLimit });
  const cache = (await readCache(cachePath)) ?? { schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-manifest", images: [], failures: [] };
  const byHash = new Map(cache.images.map((image) => [image.hash, image]));
  const images = [...cache.images];
  const failures = [...(cache.failures ?? [])];
  let generated = 0;
  let cached = 0;
  let skipped = 0;

  for (const item of planned) {
    if (byHash.has(item.hash)) {
      const existing = byHash.get(item.hash);
      // Only a cache hit whose bytes are still on disk is reusable.
      try {
        const info = await stat(resolve(existing.path));
        const detected = detectImage(await readFile(resolve(existing.path)));
        if (info.isFile() && info.size === existing.byteCount && detected.width === existing.width) {
          cached += 1;
          skipped += 1;
          continue;
        }
      } catch { /* fall through and regenerate */ }
    }
    if (generated + failures.length >= max) {
      failures.push({ optionId: item.optionId, code: "generation_limit", message: "Skipped: the 600-image benchmark budget is spent." });
      continue;
    }
    const review = normalizeReview({
      reviewId: item.scenarioId, round: 1, stages: [{
        id: item.stageId, kind: "draft", header: item.stageId, prompt: item.prompt,
        options: [
        { id: item.optionKey, label: item.optionLabel, description: item.prompt, generate: { prompt: item.prompt, provider: "agnes" } },
        // The schema requires a real choice; this filler is never generated and
        // is only here so the single-option generation request validates.
        { id: `${item.optionKey}-filler`, label: 'Unchanged baseline', description: 'Baseline treatment without a generated image.' },
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
        prompt: item.prompt, hash: item.hash, path: resolve(out).endsWith(image.path) ? image.path : image.path,
        relativePath: image.path, provider: "agnes", model: image.model,
        mimeType: detected.mimeType, width: detected.width, height: detected.height, byteCount: bytes.length,
        generatedAt: new Date().toISOString(),
      };
      images.push(entry);
      byHash.set(item.hash, entry);
      generated += 1;
      log({ event: "generated", optionId: item.optionId, width: detected.width, height: detected.height, total: generated + cached });
      await writeJson(cachePath, { ...cache, images, failures });
    } catch (error) {
      const failure = {
        optionId: item.optionId, scenarioId: item.scenarioId, code: error?.code ?? "request_failed",
        message: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
      };
      failures.push(failure);
      log({ event: "failed", ...failure });
      await writeJson(cachePath, { ...cache, images, failures });
    }
  }
  const manifest = { schemaVersion: SCHEMA_VERSION, kind: "benchmark-image-manifest", provider: "agnes", planned: planned.length, images, failures };
  assertNoCredentials(manifest);
  await writeJson(cachePath, manifest);
  return { manifest, generated, cached, skipped, failures: failures.length, planned: planned.length };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { corpus: "string", out: "string", cache: "string", max: "number", scenarios: "number", quiet: "boolean" });
  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const result = await runGeneration(corpus, {
    max: args.max ?? HARD_CAP,
    out: args.out ?? DEFAULT_IMAGE_OUT,
    cachePath: args.cache ?? ".pi/benchmark/image-manifest.json",
    scenarioLimit: args.scenarios ?? Infinity,
    log: args.quiet ? () => {} : (event) => process.stderr.write(`${JSON.stringify(event)}\n`),
  });
  process.stdout.write(`${JSON.stringify({ planned: result.planned, generated: result.generated, cached: result.cached, failures: result.failures, max: args.max ?? HARD_CAP })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:generate-images: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
