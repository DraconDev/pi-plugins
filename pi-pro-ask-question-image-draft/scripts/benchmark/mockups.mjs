#!/usr/bin/env node
/**
 * The gating visual arm: deterministic mockups drawn by the package.
 *
 * The benchmark measured that a generative image cannot carry a preview at
 * terminal size - 34.5% of generated previews were judged severely unreadable on
 * the 31 x 16 cell grid the TUI actually displays - so the image the user is
 * asked to decide from is now drawn by `src/mockup-renderer.ts` from the
 * option's own content. The generated set is kept and reported as the
 * non-gating artistic reference the objective permits.
 *
 * The spec is a pure function of the scenario and the option: layout from the
 * treatment's own vocabulary, row content from the words the corpus already
 * uses, and no option label, so the judged comparison stays blinded. Nothing here
 * calls a provider, so this arm costs nothing and reproduces byte-identically.
 */
import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DEFAULT_MOCKUP_CELLS, renderMockup } from "../../src/mockup-renderer.ts";
import { assertNoCredentials, BenchmarkError, parseArgs, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { compositionFor } from "./composition.mjs";
import { treatmentKey } from "./image-prompt.mjs";

export const MOCKUP_DIR = ".pi/benchmark/mockups";
export const MOCKUP_MANIFEST = ".pi/benchmark/mockup-manifest.json";

/** Treatment vocabulary -> the arrangement the renderer draws. */
const LAYOUTS = {
  airy: "airy", spacious: "airy", minimal: "airy", simple: "airy", glance: "airy", focus: "airy", focused: "airy",
  split: "split", paired: "split", columns: "split", board: "split", multi: "split", board2: "split",
  dense: "dense", detail: "dense", complete: "dense", table: "dense", grid: "dense", matrix: "dense",
  rows: "dense", cells: "dense", checklist: "dense", exact: "dense", tiles: "tiles", cards: "tiles", tiles2: "tiles",
  rail: "rail", sidebar: "rail", breadcrumb: "rail", accordion: "rail", search: "rail", pagination: "rail",
  steps: "steps", stages: "steps", stage: "steps", flow: "steps", pipeline: "steps", phased: "steps",
  linear: "steps", staged: "steps", progress: "steps", phased2: "steps", cycle: "steps", loop: "steps",
  bars: "chart", bar: "chart", line: "chart", lines: "chart", curve: "chart", curves: "chart", trend: "chart",
  sparkline: "chart", scatter: "chart", bubbles: "chart", radar: "chart", heatmap: "chart", heat: "chart",
  histogram: "chart", distribution: "chart", bands: "chart", range: "chart", gauge: "chart", band: "chart",
  bins: "chart", plot: "chart", diverging: "chart", interval: "chart", zone: "chart", zones: "chart",
  gantt: "chart", timeline: "chart", sankey: "chart", treemap: "chart", funnel: "chart", pyramid: "chart",
  rings: "chart", multiples: "chart", density: "chart", gradient: "chart", mix: "chart", spread: "chart",
  comparison: "chart", compare: "chart", levels: "chart", matrix2: "chart", cells2: "chart",
  // Content treatments: these name what the treatment shows rather than how the
  // screen is arranged, and they still imply a shape.
  priority: "list", narrative: "list", story: "list", digest: "list", thread: "list", review: "list",
  grouped: "list", ranked: "list", queue: "list", events: "list", summary2: "list", panel: "list",
  inline2: "list", flat: "list", live: "list", submit: "list", scroll: "list", pages2: "list",
  matrix: "chart", note: "list", notes: "list", release: "list", safe: "list", belief: "list",
  illustration: "tiles", artwork: "tiles", empty: "tiles", friendly: "tiles", preview: "tiles",
  checklist: "dense", badges: "dense", scores: "dense", ranked2: "dense", counter: "dense",
  matrixgrid: "chart", scorecard2: "chart", portal: "rail", hub2: "rail", loop2: "chart",
  profile: "list", portrait: "list", typographic: "list", type: "list", geometric: "list", plain: "list",
  plain2: "list", hybrid: "list", multimodal: "list", editorial: "list", wayfinding: "chart",
  icon: "list", icons: "list", duotone: "list", colour: "list", color: "list", front: "list",
  zones2: "chart", overlays: "list", tabs: "rail", tab: "rail", accordion2: "list", wizard2: "steps",
  breadcrumb2: "rail", pagination2: "rail", filter: "list", chips: "list", drag: "list",
  nested: "list", layer: "list", layers: "list", stack: "list", stacked2: "list", rail2: "list",
  outlet: "list", outlet2: "list", highlight2: "list", zoom2: "list", insets: "list",
};

/** Layouts a case's options may be spread across when their words name no shape. */
// Every arrangement the renderer can draw, so three options of one case can
// never be rendered the same way: an earlier eight-entry rotation ran out and
// left 16 cases with two identical structures, which is the one comparison no
// reader can make.
const FALLBACK_ROTATION = ["list", "dense", "split", "chart", "rail", "tiles", "steps", "airy", "board", "overlay"];

/** Treatment vocabulary -> a prominent shape, when the treatment is about one. */
const EMPHASIS = {
  dialog: "dialog", banner: "banner", toast: "toast", sheet: "sheet", highlight: "highlight",
  overlay: "sheet", drawer: "sheet", hero: "highlight", heroimage: "highlight", zoom: "highlight",
  priority: "highlight", lanes: "highlight", swimlane: "highlight", ranked: "highlight", inline2: "highlight",
};

const CHART_TITLES = /heatmap|histogram|curves|gauge|forecast|band|waterfall|sankey|treemap|scatter|bubbles|radar|pyramid|rings|chromosome|locus|basin|mesh|network|topology|tree|state machine|sequence|sync|pipeline|flow|gantt|timeline|cycle|loop|map|spread|distribution|mix|trend|comparison|density|gradient|range|interval|scorecard|oee|summary|season|sample|profile|load|retention|utilization|basin/i;

const STOP_WORDS = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "for", "with", "by", "from", "is", "are", "be", "as", "it", "its", "this", "that", "how", "what", "which", "same", "three", "across", "between", "without", "losing", "their", "them", "into", "out", "up", "down", "view", "screen", "page", "thing", "way", "more", "less", "most", "all", "one", "two", "six", "ten"]);

/** The words a mockup shows: the scenario's own vocabulary, longest first. */
export function contentWords(scenario) {
  const title = String(scenario.canonicalInput?.title ?? "");
  const prompt = String(scenario.visualPrompt?.prompt ?? scenario.canonicalInput?.stages?.[0]?.prompt ?? "");
  const seen = new Set();
  const words = [];
  for (const word of `${title} ${prompt}`.split(/[^A-Za-z0-9+-]+/)) {
    const value = word.trim();
    if (value.length < 3 || value.length > 14) continue;
    if (STOP_WORDS.has(value.toLowerCase())) continue;
    if (seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    words.push(value.toUpperCase());
  }
  return words;
}

/** A stable pseudo-random in [0,1) from a string, so every mockup is reproducible. */
function seededFraction(seedText) {
  let hash = 2166136261;
  for (const character of seedText) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return (hash % 10_000) / 10_000;
}

const STATUSES = ["ok", "ok", "ok", "warn", "ok", "danger"];

/** Rows for one option: enough to fill the frame, drawn from the scenario's words. */
export function rowsFor(scenario, option, { layout }) {
  const capacity = layout === "airy" ? 4 : layout === "tiles" ? 9 : layout === "split" || layout === "board" ? 12 : 13;
  const words = contentWords(scenario);
  const pool = words.length ? words : ["ITEM"];
  const rows = [];
  for (let index = 0; index < capacity; index += 1) {
    const word = pool[index % pool.length];
    const serial = String((index % 9) + 1).padStart(2, "0");
    const fraction = seededFraction(`${scenario.id}:${option.key ?? option.id}:${index}`);
    const status = STATUSES[Math.floor(fraction * STATUSES.length)];
    const label = layout === "chart"
      ? `${word.slice(0, 11)} ${serial}`
      : `${word.slice(0, 9)} ${serial}${status === "danger" ? " DELAY" : status === "warn" ? " LATE" : " OK"}`;
    rows.push({
      status,
      code: layout === "chart" ? serial : word.slice(0, 3).toUpperCase(),
      label,
      value: Math.round((0.15 + ((fraction * 7) % 0.8)) * 100) / 100,
    });
  }
  return rows;
}

/**
 * Composition family -> the arrangement `src/mockup-renderer.ts` draws.
 *
 * The renderer could draw every treatment the same way, and did: a row list
 * whatever the treatment named. The judge charged the composed previews for it -
 * 82 of 91 losses named the drawn rows as "pixelated" or "unreadable at terminal
 * size", and the cases that suffered worst were the ones whose subject is not a
 * dashboard at all (posters, packaging, icon sets, scientific diagrams), where
 * a row list is simply the wrong shape. Drawing the arrangement the treatment
 * actually names puts the information where the reader looks for it and leaves
 * far fewer glyphs on screen.
 */
export const FAMILY_LAYOUTS = Object.freeze({
  single: "airy", column: "airy", column2: "airy", column4: "list", list: "list",
  split: "split", board: "board", band: "split", rail: "rail", pages: "split", stages: "steps",
  steps: "steps", flow: "steps", tree: "steps", timeline: "steps", hub: "steps", phases: "steps",
  grid: "dense", matrix: "dense", dense: "dense", tiles: "tiles", icon: "tiles", cards: "tiles",
  chart: "chart", gauge: "chart", map: "board", zones: "board", wayfinding: "board",
  stack: "overlay", overlay: "overlay", sheet: "overlay", dialog: "overlay", toast: "overlay",
  banner: "overlay", hero: "airy", emphasis: "overlay", progressive: "list",
});

/** The arrangement one option's own composition asks the renderer to draw. */
export function layoutForComposition(option, siblings = []) {
  const { family } = compositionFor(option, siblings);
  return FAMILY_LAYOUTS[family] ?? LAYOUTS[treatmentKey(option)] ?? "list";
}

/** The spec one option renders, with no de-collision. This is the product path. */
export function mockupSpecFor(scenario, option) {
  const key = treatmentKey(option);
  const title = String(scenario.canonicalInput?.title ?? "");
  const layout = layoutForComposition(option) ?? (CHART_TITLES.test(title) ? "chart" : "list");
  return assembleSpec(scenario, option, layout, key, false);
}

function assembleSpec(scenario, option, layout, key, adjusted) {
  const title = String(scenario.canonicalInput?.title ?? "");
  const emphasis = EMPHASIS[key] ?? (["banner", "toast", "dialog", "sheet"].includes(key) ? key : undefined);
  const headers = layout === "chart"
    ? [String(title).split(/\s+/)[0]?.toUpperCase().slice(0, 11) || "ITEM", "VALUE"]
    : undefined;
  return {
    layout,
    // No title bar: the option's own name would tell the judge which arm it is.
    title: undefined,
    emphasis,
    headers,
    rows: rowsFor(scenario, option, { layout }),
    // Recorded per image: whether the arrangement came from the treatment's own
    // vocabulary or was spread across a distinct one because a sibling would
    // otherwise have been identical.
    layoutSource: adjusted ? "spread" : "treatment",
  };
}

/**
 * The three treatments of a case, guaranteed to render differently.
 *
 * 52 of 200 cases name their treatments by *content* ("Priority", "Narrative",
 * "Illustration") rather than by arrangement, so a vocabulary lookup alone drew
 * all three the same way. A case whose options are visually identical cannot be
 * decided from an image by anyone, which makes the case measurement-dead in both
 * arms rather than a win for either. Where the words do not name a shape, the
 * options are spread deterministically across arrangements and the spec records
 * that it was forced, so an auditor can see exactly which cases those were.
 */
export function specsForScenario(scenario) {
  const options = (scenario.canonicalInput?.stages ?? [])[0]?.options ?? [];
  const proposed = options.map((option, index) => {
    const key = treatmentKey(option);
    return { option, key, layout: layoutForComposition(option, options.filter((other) => other !== option)) };
  });
  const used = new Set();
  return proposed.map((item, index) => {
    let layout = item.layout;
    let forced = false;
    if (used.has(layout)) {
      // Take the next arrangement no sibling has taken, deterministically.
      const start = index % FALLBACK_ROTATION.length;
      for (let step = 0; step < FALLBACK_ROTATION.length; step += 1) {
        const candidate = FALLBACK_ROTATION[(start + step) % FALLBACK_ROTATION.length];
        if (!used.has(candidate)) { layout = candidate; forced = true; break; }
      }
    }
    used.add(layout);
    return assembleSpec(scenario, item.option, layout, item.key, forced);
  });
}

function specHash(spec) {
  return createHash("sha256").update(JSON.stringify(spec), "utf8").digest("hex");
}

/** Render every visual scenario's options and return a manifest shaped like the image manifest. */
export async function runMockups(corpus, {
  out = MOCKUP_DIR, cache = MOCKUP_MANIFEST, max = 600, widthCells = DEFAULT_MOCKUP_CELLS.widthCells, heightCells = DEFAULT_MOCKUP_CELLS.heightCells,
} = {}) {
  const planned = [];
  for (const scenario of corpus.scenarios) {
    if (scenario.stratum !== "visual") continue;
    for (const stage of scenario.canonicalInput.stages ?? []) {
      const specs = specsForScenario(scenario);
      for (const [index, option] of stage.options.entries()) {
        const spec = specs[index] ?? mockupSpecFor(scenario, option);
        planned.push({
          optionId: `${scenario.id}:${option.key ?? option.id ?? option.label}`,
          scenarioId: scenario.id,
          stratum: scenario.stratum,
          stageId: stage.id,
          optionKey: option.key ?? option.id ?? option.label,
          optionLabel: option.label,
          layout: spec.layout,
          layoutSource: spec.layoutSource,
          spec,
          hash: specHash(spec),
        });
      }
    }
  }
  if (planned.length > max) throw new BenchmarkError("generation_limit", `Mockup plan needs ${planned.length} images but --max is ${max}.`);
  mkdirSync(resolve(out), { recursive: true, mode: 0o700 });
  let previous = null;
  try { previous = JSON.parse(await readFile(resolve(cache), "utf8")); } catch { previous = null; }
  const byHash = new Map((previous?.images ?? []).map((image) => [image.hash, image]));
  const images = [];
  let generated = 0;
  let cached = 0;
  for (const item of planned) {
    const target = resolve(out, `${item.scenarioId}-${item.optionKey}.png`);
    const existing = byHash.get(item.hash);
    if (existing && existsPath(existing.path) && existing.path === target) {
      images.push(existing);
      cached += 1;
      continue;
    }
    const rendered = renderMockup(item.spec, { widthCells, heightCells });
    await writeFile(target, rendered.png, { mode: 0o600 });
    const entry = {
      id: item.optionId,
      optionIds: [item.optionId],
      scenarioId: item.scenarioId,
      stratum: item.stratum,
      layout: item.layout,
      layoutSource: item.layoutSource,
      // The spec is the image's provenance: the composed arm composes the art
      // into this exact structure, and a manifest that could not say which
      // structure it was would make that composition unreproducible.
      spec: item.spec,
      prompt: `mockup:${item.layout}:${item.hash.slice(0, 16)}`,
      hash: item.hash,
      path: target,
      provider: "mockup",
      model: "deterministic-cell-renderer",
      mimeType: "image/png",
      width: rendered.width,
      height: rendered.height,
      byteCount: rendered.png.length,
      generatedAt: new Date().toISOString(),
    };
    images.push(entry);
    generated += 1;
  }
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-image-manifest",
    provider: "mockup",
    arm: "deterministic",
    planned: planned.length,
    grid: { widthCells, heightCells, ...DEFAULT_MOCKUP_CELLS },
    images,
    failures: [],
  };
  assertNoCredentials(manifest);
  await writeJson(cache, manifest);
  return { manifest, generated, cached, planned: planned.length };
}

function existsPath(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { corpus: "string", out: "string", cache: "string", max: "number" });
  const { readJson } = await import("./common.mjs");
  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const { manifest, generated, cached, planned } = await runMockups(corpus, {
    out: args.out ?? MOCKUP_DIR, cache: args.cache ?? MOCKUP_MANIFEST, max: args.max ?? 600,
  });
  const bytes = manifest.images.reduce((sum, image) => sum + image.byteCount, 0);
  process.stdout.write(`${JSON.stringify({ out: args.out ?? MOCKUP_DIR, manifest: args.cache ?? MOCKUP_MANIFEST, planned, generated, cached, images: manifest.images.length, totalBytes: bytes, providerCalls: 0 })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:mockups: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
