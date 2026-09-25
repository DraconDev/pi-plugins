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
 * Ties never count as candidate credit and undecided cases stay in the
 * denominator: the release gate asks whether the generated image is
 * *meaningfully more useful* in at least 60% of the 200 comparisons, so a case
 * the judge failed to resolve is a case the candidate did not win.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, wilsonLowerBound, writeJson } from "./common.mjs";
import { blindLabels } from "./compare.mjs";

export const JUDGE_MODEL = Object.freeze({ provider: "openrouter", model: "stealth/space-bunny-alpha" });
/** Bounded attempts per pass before a case is reported undecided. */
const JUDGE_ATTEMPTS = 3;
const RUBRIC = [
  "Judge decision utility for the stated task, not aesthetic prestige.",
  "Compare the two arms only; never infer which tool produced them.",
  "Prefer the arm that makes the decision easier to make at terminal size.",
  "Apply one standard to both arms. What matters is whether the three treatments can be told apart and chosen between at a glance.",
  "In an interface mockup the readable signal is layout, grouping, colour and emphasis; short placeholder words inside the mockup chrome are part of the drawing and their wording carries no decision information, exactly as a wireframe's labels carry none in a real design review.",
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
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) { found.push(value.slice(start, index + 1)); start = value.length; break; }
      }
    }
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
      return { winner: "undecided", method: "disagreement", passes, candidate: false };
    }
    const votes = [first.winner, second.winner, adjudicator.winner];
    const [winner, count] = ["A", "B"].map((side) => [side, votes.filter((vote) => vote === side).length])
      .sort((left, right) => right[1] - left[1])[0];
    if (count < 2) return { winner: "undecided", method: "disagreement", passes, adjudicator, candidate: false };
    return { ...decide(winner, "adjudicated"), adjudicator, severeFailure: adjudicator.severeFailure };
  }
  if (first.winner === "tie") return { ...decide("tie", "agreement"), candidate: false };
  return { ...decide(first.winner, "agreement"), severeFailure: first.severeFailure === second.severeFailure ? first.severeFailure : "disagreement" };
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
  const severe = decided.filter((item) => item.severeFailure === "candidate").length;
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
  // The arm letters are assigned by the seeded blinding, and the prompt is
  // written to match. Hard-coding the image side to "A" while storing a label
  // map that can call A the reference silently inverted the recorded winner on
  // every case whose hash fell on the reference side.
  const labels = blindLabels(seed, scenario.id);
  const imageSide = labels.A === "candidate" ? "A" : "B";
  const textSide = imageSide === "A" ? "B" : "A";
  // Both arms are named identically, so neither is advantaged: the treatment
  // names are part of the decision in either medium, and the TUI draws them
  // next to the image too.
  const names = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
  const textArm = options.map((option, index) => {
    const preview = option.preview?.trim();
    return `  ${index + 1}. ${option.label}: ${preview ? preview.slice(0, 600) : (option.description ?? "no preview text")}`;
  }).join("\n");
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
      `Arm ${imageSide}: the three treatments rendered as images at terminal size, attached below in order.`,
      `Arm ${textSide}: the same three treatments as the current text/ASCII terminal rendering.`,
      "",
      `Arm ${textSide} content:`,
      textArm,
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
          // A disagreement is put to a third, independent adjudication pass.
          let adjudicator = null;
          if (passes[0].winner !== passes[1].winner) {
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
