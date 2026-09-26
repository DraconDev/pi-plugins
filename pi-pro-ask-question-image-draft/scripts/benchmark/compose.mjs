#!/usr/bin/env node
/**
 * The composed arm, which is a *product capability* rather than the gated arm.
 *
 * The release gate measures the generated image on its own, because that is what
 * the objective names ("Agnes must be meaningfully more useful..."). This script
 * builds the other preview the package can render - the deterministic structure
 * with the art inside it - and the report carries its numbers beside the gated
 * arm so both are visible. It does not decide anything on its own.
 *
 * `src/preview-composer.ts` draws the deterministic structure and places the
 * generated art inside it. This script runs that product path over the whole
 * visual stratum and writes a manifest shaped exactly like the generated-image
 * manifest, so the judge, the report and the contract aliases can consume either
 * arm without knowing which one they are reading.
 *
 * The generated set is not discarded: `judge.mjs` is run against both manifests
 * and the report carries both numbers, because the honest question is not
 * "composed or raw" but "what does the art add to the text presentation, and
 * what does the composition guarantee". A single number would hide one of those.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_MOCKUP_CELLS, renderMockup } from "../../src/mockup-renderer.ts";
import { composePreview } from "../../src/preview-composer.ts";
import { decodePng } from "../../src/png.ts";
import { assertNoCredentials, BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { detectImage, promptHash } from "./images.mjs";

export const COMPOSED_DIR = ".pi/benchmark/composed";
export const COMPOSED_MANIFEST = ".pi/benchmark/composed-manifest.json";

/**
 * Compose every visual option that has both a structure and an art file.
 *
 * The composition is a pure function of (spec, art bytes), so a rerun with the
 * same inputs rewrites byte-identical previews and the manifest is a cache like
 * any other.
 */
export async function runComposition({ mockups, images, out = COMPOSED_DIR, cache = COMPOSED_MANIFEST, max = 600 } = {}) {
  if (!Array.isArray(mockups?.images) || !Array.isArray(images?.images)) {
    throw new BenchmarkError("manifest_missing", "Composed previews need the mockup manifest and the image manifest.");
  }
  const structures = new Map();
  for (const entry of mockups.images) {
    for (const id of entry.optionIds ?? []) structures.set(id, entry);
  }
  const arts = new Map();
  for (const entry of images.images) {
    for (const id of entry.optionIds ?? []) arts.set(id, entry);
  }
  const missing = [];
  for (const [id, entry] of structures) {
    if (!arts.has(id)) missing.push(id);
  }
  await mkdir(resolve(out), { recursive: true });
  const composed = [];
  for (const [id, entry] of structures) {
    const art = arts.get(id);
    if (!art) continue;
    const bytes = await readFile(resolve(art.path));
    const rendered = composePreview({
      spec: entry.spec,
      art: decodePng(bytes),
      widthCells: entry.widthCells ?? DEFAULT_MOCKUP_CELLS.widthCells,
      heightCells: entry.heightCells ?? DEFAULT_MOCKUP_CELLS.heightCells,
    });
    const target = resolve(out, `${id.replace(/[^A-Za-z0-9._-]+/g, "_")}.png`);
    await writeFile(target, rendered.png);
    const detected = detectImage(rendered.png);
    composed.push({
      ...entry,
      id,
      optionIds: [id],
      path: target,
      provider: "composed",
      model: `deterministic-cell-renderer+${art.model ?? "agnes"}`,
      mimeType: detected.mimeType,
      width: detected.width,
      height: detected.height,
      byteCount: detected.byteCount ?? rendered.png.length,
      artPath: art.path,
      artHash: art.hash,
      prompt: `composed:${entry.hash ?? promptHash(entry.prompt ?? id)}`,
      hash: entry.hash ?? promptHash(entry.prompt ?? id),
      composedAt: new Date().toISOString(),
    });
  }
  if (composed.length > max) throw new BenchmarkError("generation_limit", `Composed set has ${composed.length} previews but --max is ${max}.`);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-image-manifest",
    arm: "composed",
    provider: "composed",
    grid: { widthCells: DEFAULT_MOCKUP_CELLS.widthCells, heightCells: DEFAULT_MOCKUP_CELLS.heightCells },
    planned: structures.size,
    composed: composed.length,
    withoutArt: missing.length,
    withoutArtIds: missing.slice(0, 20),
    images: composed,
    failures: [],
  };
  assertNoCredentials(manifest);
  await writeJson(cache, manifest);
  return manifest;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { mockups: "string", images: "string", out: "string", cache: "string", max: "number" });
  const mockups = await readJson(args.mockups ?? ".pi/benchmark/mockup-manifest.json", "manifest_missing");
  const images = await readJson(args.images ?? ".pi/benchmark/image-manifest.json", "manifest_missing");
  const manifest = await runComposition({
    mockups, images,
    out: args.out ?? COMPOSED_DIR,
    cache: args.cache ?? COMPOSED_MANIFEST,
    max: args.max ?? 600,
  });
  process.stdout.write(`${JSON.stringify({ cache: args.cache ?? COMPOSED_MANIFEST, planned: manifest.planned, composed: manifest.composed, withoutArt: manifest.withoutArt, providerCalls: 0 })}\n`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:compose: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
