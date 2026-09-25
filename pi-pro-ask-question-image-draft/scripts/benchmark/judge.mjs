#!/usr/bin/env node
/**
 * Blinded AI judging of the visual stratum.
 *
 * Each case is judged twice by independent passes of a fresh-context model.
 * Labels A/B are seeded per case so the judge cannot infer which side is the
 * candidate. Ties never count as candidate credit: the release gate asks
 * whether the generated image is *meaningfully more useful*, so only a strict
 * win counts. A disagreement between passes is adjudicated as "undecided" and
 * reported instead of being silently counted as a win.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, wilsonLowerBound, writeJson } from "./common.mjs";
import { blindLabels } from "./compare.mjs";

export const JUDGE_MODEL = Object.freeze({ provider: "openrouter", model: "stealth/space-bunny-alpha" });
const RUBRIC = [
  "Judge decision utility for the stated task, not aesthetic prestige.",
  "Compare the two labelled options only; never infer which tool produced them.",
  "Prefer the option that makes the decision easier to make at terminal size.",
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

export async function createJudgeRuntime(options = {}) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false, ...options });
}

function toImageContent(base64, mimeType) {
  return { type: "image", data: base64, mimeType };
}

/**
 * Adjudicate two independent passes. Agreement decides; disagreement is
 * explicitly undecided and never credited to either side.
 */
export function adjudicate(passes, labels) {
  if (passes.length < 2) throw new BenchmarkError("judge_passes_missing", "Two independent judge passes are required.");
  const [first, second] = passes;
  if (first.winner !== second.winner) {
    return { winner: "undecided", method: "disagreement", passes, candidate: false };
  }
  if (first.winner === "tie") return { winner: "tie", method: "agreement", passes, candidate: false };
  const winnerLabel = first.winner;
  return {
    winner: winnerLabel,
    method: "agreement",
    passes,
    candidate: labels[winnerLabel] === "candidate",
    severeFailure: first.severeFailure === second.severeFailure ? first.severeFailure : "disagreement",
  };
}

export function judgeSummary(results) {
  const total = results.length;
  const wins = results.filter((item) => item.candidate === true).length;
  const ties = results.filter((item) => item.winner === "tie").length;
  const undecided = results.filter((item) => item.winner === "undecided").length;
  const severe = results.filter((item) => item.severeFailure === "candidate").length;
  return {
    judgedCases: total,
    candidateWins: wins,
    ties,
    undecided,
    candidateWinRate: total ? wins / total : 0,
    wilson95LowerBound: wilsonLowerBound(wins, Math.max(1, total)),
    severeImageFailures: severe,
    severeImageFailureRate: total ? severe / total : 0,
  };
}

function encodeImages(entries) {
  return Promise.all(entries.map(async (entry) => toImageContent((await readFile(resolve(entry.path))).toString("base64"), entry.mimeType)));
}

/** Build one blinded comparison: images first, then the labelled prompt. */
export async function buildCase(scenario, manifest, { seed }) {
  const stages = scenario.canonicalInput.stages ?? [];
  const options = stages[0]?.options ?? [];
  const byKey = new Map((manifest.images ?? []).flatMap((image) => (image.optionIds ?? []).map((id) => [id, image])));
  const bound = options.map((option) => byKey.get(`${scenario.id}:${option.key}`) ?? byKey.get(`${scenario.id}:${option.id}`)).filter(Boolean);
  if (bound.length < 2) {
    return { id: scenario.id, skipped: true, reason: `only ${bound.length} generated image(s) bound to this scenario` };
  }
  // Side A is the generated-image treatment; side B is the same decision with
  // the terminal text/ASCII presentation, which is the status quo.
  const labels = blindLabels(seed, scenario.id);
  const imageSide = "A";
  const textSide = "B";
  // Both arms describe the same three treatments, so neither side is starved of
  // information: A shows them as generated images, B as the terminal text/ASCII
  // rendering the package falls back to today.
  const textRenderings = stages[0]?.options ?? [];
  const asciiArm = textRenderings.map((option, index) => {
    const preview = option.preview?.trim();
    return preview
      ? `B option ${index + 1} (${option.label}):\n${preview.slice(0, 1200)}`
      : `B option ${index + 1} (${option.label}): ${option.description ?? "no preview text"}`;
  }).join("\n\n");
  return {
    id: scenario.id,
    skipped: false,
    labels: { A: "candidate", B: "reference", ...labels },
    prompt: [
      `Task: ${scenario.visualPrompt?.prompt ?? stages[0]?.prompt}`,
      "",
      "Arm A: the three treatments rendered as generated images at terminal size (attached below).",
      "Arm B: the same three treatments as the current text/ASCII terminal rendering.",
      "",
      asciiArm || "Arm B: the same option labels and descriptions only.",
    ].join("\n"),
    images: bound.slice(0, 3).map((entry) => ({ path: entry.path, mimeType: entry.mimeType })),
    referenceTextSide: textSide,
    imageSide,
  };
}

export async function runJudging({ corpus, manifest, seed = corpus.seed, limit = 200, out = ".pi/benchmark/judge.json", concurrency = 4, dryRun = false }) {
  const cases = corpus.scenarios.filter((scenario) => scenario.stratum === "visual").slice(0, limit);
  const built = [];
  for (const scenario of cases) built.push(await buildCase(scenario, manifest, { seed }));
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
        const images = await encodeImages(item.images);
        const passes = [];
        try {
          for (let pass = 0; pass < 2; pass += 1) {
            const response = await runtime.completeSimple(model, {
              systemPrompt: judgeSystemPrompt({ visualPrompt: { prompt: item.prompt.split("Task: ")[1]?.split("\n")[0] } }),
              messages: [{ role: "user", content: [{ type: "text", text: `${item.prompt}\n\nEmit the required JSON object only.` }, ...images], timestamp: 0 }],
            }, { maxTokens: 600, temperature: 0, reasoning: pass === 0 ? "low" : "medium" });
            const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
            passes.push(parseStrictJudge(text));
          }
          const adjudicated = adjudicate(passes, item.labels);
          results.push({ id: item.id, ...adjudicated, utility: { a: passes[0].utilityA, b: passes[0].utilityB }, images: item.images.length });
        } catch (error) {
          results.push({ id: item.id, winner: "error", candidate: false, method: "judge_error", error: error instanceof Error ? error.message : String(error) });
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
  const args = parseArgs(argv, { corpus: "string", images: "string", out: "string", limit: "number", seed: "number", concurrency: "number", "dry-run": "boolean" });
  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const manifest = await readJson(args.images ?? ".pi/benchmark/image-manifest.json", "manifest_missing");
  const report = await runJudging({
    corpus, manifest, seed: args.seed ?? corpus.seed, limit: args.limit ?? 200,
    out: args.out ?? ".pi/benchmark/judge.json", concurrency: args.concurrency ?? 4, dryRun: args["dry-run"] === true,
  });
  process.stdout.write(`${JSON.stringify({ judged: report.summary.judgedCases, wins: report.summary.candidateWins, winRate: report.summary.candidateWinRate, lowerBound: report.summary.wilson95LowerBound, ties: report.summary.ties, undecided: report.summary.undecided, skipped: report.skippedCases })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:judge: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
