#!/usr/bin/env node
/**
 * Blinded AI judging of the visual stratum.
 *
 * Each case is judged twice by independent passes of a fresh-context model; a
 * disagreement is then put to a third, independent adjudicator pass and decided
 * by majority. Arm letters are assigned per case by `blindLabels` and the prompt
 * is written to match that assignment, so the model cannot infer which side is
 * the candidate and the recorded winner is attributed correctly.
 *
 * Two measurement conditions are load-bearing and were both wrong before:
 *
 * 1. The images are attached as the raster a *terminal user actually sees*.
 *    `scripts/benchmark/terminal-render.mjs` resamples each generated PNG onto
 *    the exact cell grid `src/tui.ts` gives an option preview (31 x 16 cells on
 *    a 110-column terminal). Attaching the untouched 1024x1024 file scored
 *    detail that no user could resolve.
 * 2. The baseline arm is the text presentation the package renders today
 *    (`scripts/benchmark/text-arm.mjs` reproduces `renderRows` and
 *    `fallbackPreview`), not a hand-written summary of the options.
 *
 * Ties never count as candidate credit and undecided cases stay in the
 * denominator: the release gate asks whether the generated image is
 * *meaningfully more useful* in at least 60% of the 200 comparisons, so a case
 * the judge failed to resolve is a case the candidate did not win.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, wilsonLowerBound, writeJson } from "./common.mjs";
import { blindLabels } from "./compare.mjs";
import { previewCellGrid, renderAtTerminalDimensions } from "./terminal-render.mjs";
import { textArmForScenario } from "./text-arm.mjs";

export const JUDGE_MODEL = Object.freeze({ provider: "openrouter", model: "stealth/space-bunny-alpha" });
/** Bounded attempts per pass before a case is reported undecided. */
const JUDGE_ATTEMPTS = 3;
const RUBRIC = [
  "Judge decision utility for the stated task, not aesthetic prestige.",
  "Compare the two arms only; never infer which tool produced them.",
  "Every image you are shown is rendered at the exact size a terminal displays it at. Judge what is visible at that size.",
  "Prefer the arm that makes the decision easier to make at that size.",
  "Mark an arm as a severe failure when its three treatments cannot be told apart at that size, or when it is unreadable, corrupted, or otherwise unusable. Report the illegibility; do not excuse it.",
  'Return exactly {"winner":"A"|"B"|"tie","utilityA":0..1,"utilityB":0..1,"severeFailure":"none"|"A"|"B"|"both","rationale":"..."}',
].join("\n");

export function judgeSystemPrompt(scenario) {
  return [
    "You are an independent decision-quality judge for a terminal UI experiment.",
    RUBRIC,
    `Task: ${scenario.visualPrompt?.prompt ?? scenario.canonicalInput?.stages?.[0]?.prompt ?? "unspecified"}`,
  ].join("\n");
}

export function parseStrictJudge(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch (cause) { throw new BenchmarkError("judge_invalid_json", "Judge did not return strict JSON.", { cause }); }
  if (!parsed || typeof parsed !== "object"
      || !["A", "B", "tie"].includes(parsed.winner)
      || typeof parsed.utilityA !== "number" || typeof parsed.utilityB !== "number"
      || !["none", "A", "B", "both"].includes(parsed.severeFailure)
      || typeof parsed.rationale !== "string") {
    throw new BenchmarkError("judge_invalid_shape", "Judge JSON does not match the required schema.");
  }
  return parsed;
}

/**
 * Read one judge reply.
 *
 * The model often wraps its object in a fenced block or a sentence of preamble.
 * That is a transport defect, not a verdict, so the object is recovered from the
 * text; the schema check behind it is unchanged, so a reply that is not a valid
 * verdict still fails. `mode` is recorded per pass so the report shows exactly
 * how many replies needed recovery.
 */
export function parseJudgeReply(value) {
  if (typeof value !== "string" || !value.trim()) throw new BenchmarkError("judge_invalid_json", "Judge did not return strict JSON.");
  try { return { verdict: parseStrictJudge(value.trim()), mode: "strict" }; } catch { /* fall through to recovery */ }
  for (const candidate of extractJsonObjects(value)) {
    try { return { verdict: parseStrictJudge(candidate), mode: "recovered" }; } catch { /* keep scanning */ }
  }
  throw new BenchmarkError("judge_invalid_json", "Judge did not return strict JSON.");
}

/** Every balanced top-level {...} span in a reply, longest first. */
function extractJsonObjects(value) {
  const found = [];
  for (let start = value.indexOf("{"); start !== -1; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) { found.push(value.slice(start, index + 1)); closed = true; break; }
      }
    }
    // Keep scanning after a span closes: a reply can wrap a decoy object around
    // the real verdict, and stopping at the first span would return the decoy.
    if (closed && depth !== 0) continue;
  }
  return found.sort((left, right) => right.length - left.length);
}

export async function createJudgeRuntime(options = {}) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, ...options });
}

function toImageContent(base64, mimeType) {
  return { type: "image", data: base64, mimeType };
}

/**
 * Normalise the judge's `severeFailure` - which names arms ("A", "B", "both") -
 * into arms this case can be charged for.
 *
 * The summary used to compare against the literal string "candidate", which the
 * judge never emits, so the severe-failure rate was structurally zero and the
 * 2% ceiling could not be measured at all. Attribution has to run through the
 * case's own label map or the cap is a rubber stamp.
 */
export function attributeSevereFailure(value, labels) {
  const raw = typeof value === "string" ? value : (value?.label ?? "none");
  if (raw !== "A" && raw !== "B" && raw !== "both") return { label: "none", candidate: false, reference: false, raw };
  const candidateArm = raw === "both" ? null : labels[raw];
  return {
    label: raw,
    candidate: raw === "both" || candidateArm === "candidate",
    reference: raw === "both" || candidateArm === "reference",
    raw,
  };
}

/**
 * Adjudicate independent passes. Agreement decides. A disagreement is put to a
 * third independent adjudicator pass and decided by majority; only a split that
 * the adjudicator cannot break stays undecided, and it is never credited.
 */
export function adjudicate(passes, labels, adjudicator = null) {
  if (passes.length < 2) throw new BenchmarkError("judge_passes_missing", "Two independent judge passes are required.");
  const [first, second] = passes;
  const decide = (winnerLabel, method) => ({
    winner: winnerLabel,
    method,
    passes,
    candidate: winnerLabel !== "tie" && labels[winnerLabel] === "candidate",
  });
  if (first.winner !== second.winner) {
    if (!adjudicator || adjudicator.winner === "tie") {
      return { winner: "undecided", method: "disagreement", passes, candidate: false, severeFailure: attributeSevereFailure("none", labels) };
    }
    const votes = [first.winner, second.winner, adjudicator.winner];
    const [winner, count] = ["A", "B"].map((side) => [side, votes.filter((vote) => vote === side).length])
      .sort((left, right) => right[1] - left[1])[0];
    if (count < 2) return { winner: "undecided", method: "disagreement", passes, adjudicator, candidate: false, severeFailure: attributeSevereFailure("none", labels) };
    // The adjudicator's severity call is the case's severity: it is the pass
    // that had to settle the case.
    return { ...decide(winner, "adjudicated"), adjudicator, severeFailure: attributeSevereFailure(adjudicator.severeFailure, labels) };
  }
  if (first.winner === "tie") return { ...decide("tie", "agreement"), candidate: false, severeFailure: attributeSevereFailure("none", labels) };
  // The winner is agreed; the severity call may still be contested, and it is
  // escalated the same way. Only a call the adjudicator cannot break stays
  // charged to both arms, and it is recorded as contested.
  if (first.severeFailure !== second.severeFailure) {
    if (!adjudicator) {
      return { ...decide(first.winner, "contested-severity"), severeFailure: attributeSevereFailure("both", labels) };
    }
    return { ...decide(first.winner, "adjudicated-severity"), adjudicator, severeFailure: attributeSevereFailure(adjudicator.severeFailure, labels) };
  }
  return { ...decide(first.winner, "agreement"), severeFailure: attributeSevereFailure(first.severeFailure, labels) };
}

export function judgeSummary(results) {
  const total = results.length;
  // Undecided and unparsable cases stay in the denominator: the gate asks for a
  // win rate over the blinded comparisons, and a case the judge could not
  // resolve is not a win for the candidate. `decidedWinRate` is reported next to
  // it as a diagnostic, never as the gate.
  const decided = results.filter((item) => item.winner !== "undecided");
  const wins = decided.filter((item) => item.candidate === true).length;
  const ties = decided.filter((item) => item.winner === "tie").length;
  const undecided = results.filter((item) => item.winner === "undecided").length;
  const judgeErrors = results.filter((item) => item.method === "judge_error").length;
  const adjudicated = results.filter((item) => item.method === "adjudicated").length;
  const recovered = results.filter((item) => item.passModes?.some((mode) => mode === "recovered")).length;
  const severe = decided.filter((item) => item.severeFailure?.candidate === true);
  const severeReference = decided.filter((item) => item.severeFailure?.reference === true);
  return {
    judgedCases: total,
    decidedCases: decided.length,
    candidateWins: wins,
    ties,
    undecided,
    judgeErrors,
    adjudicated,
    recoveredPasses: recovered,
    candidateWinRate: total ? wins / total : 0,
    wilson95LowerBound: wilsonLowerBound(wins, Math.max(1, total)),
    decidedWinRate: decided.length ? wins / decided.length : 0,
    decidedWilson95LowerBound: wilsonLowerBound(wins, Math.max(1, decided.length)),
    severeImageFailures: severe.length,
    severeImageFailureRate: total ? severe.length / total : 0,
    // The baseline is charged on the same scale, so a reader can see the cap is
    // met by measurement rather than by a lenient rubric.
    severeReferenceFailures: severeReference.length,
    severeReferenceFailureRate: total ? severeReference.length / total : 0,
  };
}

const TERMINAL_RENDER_DIR = ".pi/benchmark/terminal-renders";

/**
 * Attach the images the way a terminal user sees them.
 *
 * The rendered rasters are written to disk as well, so the measurement an
 * auditor is asked to trust is an artifact they can open, not a claim in a
 * prompt string.
 */
async function encodeImages(entries, { columns = 110, heightCells = 16, renderDir = TERMINAL_RENDER_DIR } = {}) {
  const grid = previewCellGrid({ columns, maxHeightCells: heightCells });
  await mkdir(resolve(renderDir), { recursive: true });
  return Promise.all(entries.map(async (entry) => {
    const rendered = renderAtTerminalDimensions(await readFile(resolve(entry.path)), grid);
    const name = `${String(entry.path).split("/").pop()}.${grid.widthCells}x${grid.heightCells}cells.png`;
    await writeFile(resolve(renderDir, name), rendered.png);
    return toImageContent(rendered.png.toString("base64"), "image/png");
  }));
}

/** Build one blinded comparison: images first, then the labelled prompt. */
export async function buildCase(scenario, manifest, { seed, columns = 110 }) {
  const stages = scenario.canonicalInput.stages ?? [];
  const options = stages[0]?.options ?? [];
  const byKey = new Map((manifest.images ?? []).flatMap((image) => (image.optionIds ?? []).map((id) => [id, image])));
  const bound = options.map((option) => byKey.get(`${scenario.id}:${option.key}`) ?? byKey.get(`${scenario.id}:${option.id}`)).filter(Boolean);
  if (bound.length < 2) {
    return { id: scenario.id, skipped: true, reason: `only ${bound.length} generated image(s) bound to this scenario` };
  }
  // The arm letters are assigned by the seeded blinding, and the prompt is
  // written to match. Hard-coding the image side to "A" while storing a label
  // map that can call A the reference silently inverted the recorded winner on
  // every case whose hash fell on the reference side.
  const labels = blindLabels(seed, scenario.id);
  const imageSide = labels.A === "candidate" ? "A" : "B";
  const textSide = imageSide === "A" ? "B" : "A";
  // Both arms show the same three treatments, neither side is advantaged, and
  // each arm is shown in the medium it is actually used in: the images at
  // terminal-display size, the baseline as the text the package renders today.
  const names = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
  const textArm = textArmForScenario(scenario, { columns }).split("\n").map((line) => `  ${line}`).join("\n");
  return {
    id: scenario.id,
    skipped: false,
    labels,
    prompt: [
      `Task: ${scenario.visualPrompt?.prompt ?? stages[0]?.prompt}`,
      "",
      "Three candidate treatments:",
      names,
      "",
      `Arm ${imageSide}: the three treatments as images, each rendered at the exact size a terminal displays it at. The three images are attached in order.`,
      `Arm ${textSide}: the same three treatments as the text a terminal user sees today, printed exactly as the tool renders it:`,
      textArm,
    ].join("\n"),
    images: bound.slice(0, 3).map((entry) => ({ path: entry.path, mimeType: entry.mimeType })),
    referenceTextSide: textSide,
    imageSide,
  };
}

export async function runJudging({ corpus, manifest, seed = corpus.seed, limit = 200, out = ".pi/benchmark/judge.json", concurrency = 4, dryRun = false, columns = 110, heightCells = 16, renderDir = TERMINAL_RENDER_DIR }) {
  const cases = corpus.scenarios.filter((scenario) => scenario.stratum === "visual").slice(0, limit);
  const built = [];
  for (const scenario of cases) built.push(await buildCase(scenario, manifest, { seed, columns }));
  const runnable = built.filter((item) => !item.skipped);
  const results = [];
  if (!dryRun && runnable.length) {
    const runtime = await createJudgeRuntime();
    const model = runtime.getModel(JUDGE_MODEL.provider, JUDGE_MODEL.model);
    if (!model) throw new BenchmarkError("judge_model_unavailable", `${JUDGE_MODEL.provider}/${JUDGE_MODEL.model} is unavailable in the local ModelRuntime catalog.`);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, runnable.length) }, async () => {
      while (cursor < runnable.length) {
        const item = runnable[cursor];
        cursor += 1;
        const images = await encodeImages(item.images, { columns, heightCells, renderDir });
        const passes = [];
        const passModes = [];
        const errors = [];
        const runPass = async (reasoning) => {
          // A malformed judge reply is a transport problem, not a verdict. Each
          // pass gets bounded attempts so a formatting hiccup is never recorded
          // as a loss for the candidate.
          let lastError;
          for (let attempt = 0; attempt < JUDGE_ATTEMPTS; attempt += 1) {
            try {
              const response = await runtime.completeSimple(model, {
                systemPrompt: judgeSystemPrompt({ visualPrompt: { prompt: item.prompt.split("Task: ")[1]?.split("\n")[0] } }),
                messages: [{ role: "user", content: [{ type: "text", text: `${item.prompt}\n\nEmit the required JSON object only.` }, ...images], timestamp: 0 }],
              }, { maxTokens: 600, temperature: 0, reasoning });
              const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
              const parsed = parseJudgeReply(text);
              passes.push(parsed.verdict);
              passModes.push(parsed.mode);
              return undefined;
            } catch (error) {
              lastError = error;
              errors.push(error instanceof Error ? error.message : String(error));
            }
          }
          return lastError;
        };
        for (const reasoning of ["low", "medium"]) {
          if (await runPass(reasoning)) break;
        }
        if (passes.length === 2) {
          // A disagreement is put to a third, independent adjudication pass -
          // for the winner, for the severity call, or for both. Severity used to
          // default to "both" whenever two passes differed, which charged both
          // arms for a disagreement rather than a defect and inflated the very
          // number the 2% cap is measured against.
          let adjudicator = null;
          if (passes[0].winner !== passes[1].winner || passes[0].severeFailure !== passes[1].severeFailure) {
            const previous = passes.length;
            await runPass("high");
            adjudicator = passes.length > previous ? passes[previous] : null;
          }
          const adjudicated = adjudicate(passes.slice(0, 2), item.labels, adjudicator);
          results.push({ id: item.id, ...adjudicated, passModes, utility: { a: passes[0].utilityA, b: passes[0].utilityB }, images: item.images.length });
        } else {
          // Undecided, not lost: kept in the denominator as an infrastructure
          // shortfall and reported as a judge error.
          results.push({ id: item.id, winner: "undecided", candidate: false, method: "judge_error", passModes, error: errors[errors.length - 1] ?? "judge failed" });
        }
      }
    });
    await Promise.all(workers);
  }
  const summary = judgeSummary(results);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-visual-judging",
    model: JUDGE_MODEL,
    seed,
    blinded: true,
    // The measurement condition is part of the evidence, not an implementation
    // detail: the cell grid the images were rendered to, the terminal width it
    // was derived from, and that the baseline is the package text rendering.
    condition: {
      imageArm: "generated image resampled to the inline preview cell grid",
      terminalColumns: columns,
      grid: previewCellGrid({ columns, maxHeightCells: heightCells }),
      renderedArtifacts: renderDir,
      baselineArm: "the text/ASCII presentation src/tui.ts renders when no inline image is available",
    },
    tieIsNotCredit: true,
    plannedCases: cases.length,
    skippedCases: built.filter((item) => item.skipped).length,
    skipped: built.filter((item) => item.skipped).map((item) => ({ id: item.id, reason: item.reason })),
    summary,
    results: results.sort((left, right) => left.id.localeCompare(right.id)),
  };
  await writeJson(out, report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { corpus: "string", images: "string", out: "string", limit: "number", seed: "number", concurrency: "number", "dry-run": "boolean", columns: "number", "height-cells": "number" });
  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const manifest = await readJson(args.images ?? ".pi/benchmark/image-manifest.json", "manifest_missing");
  const report = await runJudging({
    corpus, manifest, seed: args.seed ?? corpus.seed, limit: args.limit ?? 200,
    out: args.out ?? ".pi/benchmark/judge.json", concurrency: args.concurrency ?? 4, dryRun: args["dry-run"] === true,
    columns: args.columns ?? 110,
    heightCells: args["height-cells"] ?? 16,
  });
  process.stdout.write(`${JSON.stringify({ judged: report.summary.judgedCases, wins: report.summary.candidateWins, winRate: report.summary.candidateWinRate, lowerBound: report.summary.wilson95LowerBound, ties: report.summary.ties, undecided: report.summary.undecided, skipped: report.skippedCases })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:judge: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
