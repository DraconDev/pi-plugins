#!/usr/bin/env node
/**
 * Publish the benchmark evidence into the repository.
 *
 * `.pi/` is machine-local scratch (and git-ignored), so a run that leaves all of
 * its evidence there is a run nobody else can audit. This mirrors the artifacts
 * an independent reviewer needs - corpus, per-case results, image manifest,
 * judging, live-TTY smoke, report, defect ledger, activation evidence - into
 * `benchmark/`, which *is* tracked, and records a sha256 index so drift between
 * the run and the mirror is detectable.
 *
 * The 600 generated images stay out of the repository (half a gigabyte); the
 * manifest carries every prompt hash, byte count and dimension, and a small
 * sample of real generated images is published so the visual claims can be
 * looked at rather than only read about.
 */
import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";

export const EVIDENCE_DIR = "benchmark/evidence";
export const SAMPLE_DIR = `${EVIDENCE_DIR}/samples`;
/** Artifacts mirrored verbatim into the repository. */
export const MIRRORED = Object.freeze([
  ["corpus.json", ".pi/benchmark/corpus.json"],
  ["results.json", ".pi/benchmark/results.json"],
  ["image-manifest.json", ".pi/benchmark/image-manifest.json"],
  ["images.json", ".pi/benchmark/images.json"],
  ["image-report.json", ".pi/benchmark/image-report.json"],
  ["judge.json", ".pi/benchmark/judge.json"],
  ["live-smoke.json", ".pi/benchmark/live-smoke.json"],
  ["report.json", ".pi/benchmark/report.json"],
  ["defects.json", ".pi/benchmark/defects.json"],
  ["activation.json", ".pi/benchmark/activation.json"],
]);

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Hard-link when possible so a 500 KB image is not duplicated per publish. */
async function place(source, target) {
  try {
    await link(source, target);
    return "link";
  } catch {
    await copyFile(source, target);
    return "copy";
  }
}

export async function publishEvidence({ evidenceDir = EVIDENCE_DIR, sampleDir = SAMPLE_DIR, samples = 2, from = ".pi/benchmark" } = {}) {
  await mkdir(evidenceDir, { recursive: true });
  const published = [];
  const missing = [];
  for (const [name, source] of MIRRORED) {
    const sourcePath = resolve(source.replace(".pi/benchmark", from));
    if (!await exists(sourcePath)) { missing.push(name); continue; }
    const target = resolve(evidenceDir, name);
    await copyFile(sourcePath, target);
    published.push({ file: name, sha256: await sha256(target), bytes: (await stat(target)).size });
  }
  // A handful of real generated images so the visual gate can be inspected.
  const manifestPath = resolve(from, "image-manifest.json");
  let sampled = [];
  if (await exists(manifestPath)) {
    const manifest = await readJson(manifestPath, "manifest_missing");
    const corpus = await readJson(resolve(from, "corpus.json"), "corpus_missing");
    const visualIds = [...new Set(corpus.scenarios.filter((item) => item.stratum === "visual").map((item) => item.id))];
    const wanted = new Set(visualIds.slice(0, samples));
    const chosen = (manifest.images ?? []).filter((image) => wanted.has(image.scenarioId));
    if (chosen.length) {
      await rm(resolve(sampleDir), { recursive: true, force: true });
      await mkdir(sampleDir, { recursive: true });
      for (const image of chosen) {
        const target = resolve(sampleDir, `${image.scenarioId}-${image.id.split(":").pop()}.png`);
        if (!await exists(image.path)) continue;
        const mode = await place(image.path, target);
        sampled.push({ file: basename(target), scenarioId: image.scenarioId, optionId: image.id, promptHash: image.hash, bytes: image.byteCount, sha256: await sha256(target), mode });
      }
    }
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-evidence-index",
    note: "sha256 of every mirrored artifact. `npm run benchmark:verify-evidence` re-checks them.",
    artifacts: published,
    samples: sampled,
  };
  await writeJson(resolve(evidenceDir, "INDEX.json"), index);
  // A plain sha256sum file so the mirror can be checked with standard tooling.
  const lines = [
    ...published.map((item) => `${item.sha256}  ${item.file}`),
    ...sampled.map((item) => `${item.sha256}  samples/${item.file}`),
  ];
  await writeFile(resolve(evidenceDir, "SHA256SUMS"), `${lines.join("\n")}\n`, "utf8");
  return { ...index, missing };
}

export async function verifyEvidence({ evidenceDir = EVIDENCE_DIR } = {}) {
  const indexPath = resolve(evidenceDir, "INDEX.json");
  if (!await exists(indexPath)) throw new BenchmarkError("evidence_missing", `No published evidence index at ${indexPath}. Run \`npm run benchmark:publish\`.`);
  const index = await readJson(indexPath, "evidence_missing");
  const problems = [];
  for (const artifact of index.artifacts ?? []) {
    const path = resolve(evidenceDir, artifact.file);
    if (!await exists(path)) { problems.push(`${artifact.file}: missing`); continue; }
    const digest = await sha256(path);
    if (digest !== artifact.sha256) problems.push(`${artifact.file}: sha256 ${digest.slice(0, 12)} != recorded ${String(artifact.sha256).slice(0, 12)}`);
  }
  for (const sample of index.samples ?? []) {
    const path = resolve(evidenceDir, "samples", sample.file);
    if (!await exists(path)) { problems.push(`samples/${sample.file}: missing`); continue; }
    const digest = await sha256(path);
    if (sample.sha256 && digest !== sample.sha256) problems.push(`samples/${sample.file}: sha256 mismatch`);
  }
  if (problems.length) throw new BenchmarkError("evidence_drift", `Published evidence does not match its index: ${problems.join("; ")}.`);
  return { verified: true, artifacts: index.artifacts.length, samples: (index.samples ?? []).length };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { out: "string", verify: "boolean", evidence: "string", samples: "number", from: "string" });
  if (args.verify) {
    const result = await verifyEvidence({ evidenceDir: args.evidence ?? EVIDENCE_DIR });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = await publishEvidence({
    evidenceDir: args.evidence ?? EVIDENCE_DIR,
    sampleDir: `${args.evidence ?? EVIDENCE_DIR}/samples`,
    samples: args.samples ?? 2,
    from: args.from ?? ".pi/benchmark",
  });
  process.stdout.write(`${JSON.stringify({ out: args.evidence ?? EVIDENCE_DIR, artifacts: result.artifacts.length, samples: result.samples.length, missing: result.missing })}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:publish: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
