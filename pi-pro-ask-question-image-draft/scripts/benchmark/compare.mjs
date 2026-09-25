#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildResponse } from "../../src/envelope.ts";
import { runDialogReview } from "../../src/fallback.ts";
import { makeCustomAnswer, makeOptionAnswer, makeReviewResult } from "../../src/state.ts";
import { normalizeReview, validateReview } from "../../src/schema.ts";
import {
  assertNoCredentials, BenchmarkError, parseArgs, parseSeed, readJson, SCHEMA_VERSION, stableStringify, wilsonLowerBound, writeJson,
} from "./common.mjs";
import { normalizeCorpus } from "./corpus.mjs";

export const DEFAULT_CORPUS = ".pi/benchmark/corpus.json";

function normalizedAnswers(answers) {
  return (answers ?? []).map((answer) => ({
    questionIndex: answer.questionIndex,
    kind: answer.kind,
    answer: answer.answer ?? null,
    ...(answer.selected ? { selected: [...answer.selected] } : {}),
    ...(answer.notes ? { notes: answer.notes } : {}),
  }));
}

function expectedAnswers(scenario) {
  if (scenario.comparisonScope === "shared") {
    return scenario.expected.answers.map((answer) => ({
      questionIndex: answer.questionIndex,
      kind: answer.kind,
      answer: answer.answer ?? null,
      ...(answer.selected ? { selected: [...answer.selected] } : {}),
    }));
  }
  return scenario.expected.answers.map((answer) => {
    const stageIndex = scenario.canonicalInput.stages?.findIndex((stage) => stage.id === answer.stageId) ?? -1;
    return { questionIndex: stageIndex, stageId: answer.stageId, kind: answer.kind, answer: answer.answer ?? null, ...(answer.selected ? { selected: [...answer.selected] } : {}) };
  });
}

function localUi(scenario) {
  const questions = scenario.canonicalInput.questions ?? scenario.canonicalInput.stages;
  const answers = scenario.expected.answers;
  let index = 0;
  let pendingCustom;
  const selectedMulti = new Set();
  return {
    signal: new AbortController().signal,
    ui: {
      async select(title, choices) {
        if (index >= questions.length) return "Approve review";
        const stage = questions[index];
        const expected = answers.find((answer) => (answer.questionIndex ?? stage.id) === index || answer.stageId === stage.id);
        if (!expected) return "Skip stage";
        if (expected.kind === "custom") { pendingCustom = expected.answer; return "Type something."; }
        if (expected.kind === "multi") {
          const wanted = [...(expected.selected ?? expected.optionLabels ?? [])];
          const next = wanted.find((label) => !selectedMulti.has(label));
          if (next) { selectedMulti.add(next); return next; }
          index += 1;
          selectedMulti.clear();
          return "Done selecting";
        }
        const option = stage.options.find((candidate) => candidate.label === expected.answer) ?? stage.options[0];
        index += 1;
        return option.label;
      },
      async input() { const answer = pendingCustom; pendingCustom = undefined; return answer; },
      async confirm() { return true; },
      notify() {},
    },
  };
}

export async function runLocal(scenario) {
  let review;
  try {
    review = normalizeReview(structuredClone(scenario.canonicalInput), 1);
    validateReview(review);
  } catch (error) {
    return { ok: false, accepted: false, validation: error.message, result: null, response: null };
  }
  try {
    const execution = runDialogReview(localUi(scenario), review);
    const result = await Promise.race([
      execution,
      new Promise((_, reject) => setTimeout(() => reject(new BenchmarkError("local_timeout", `Local scripted execution timed out for ${scenario.id}.`)), 100).unref()),
    ]);
    return { ok: result.status === scenario.expected.outcome, accepted: true, validation: "accepted", result, response: buildResponse(result, review) };
  } catch (error) {
    return { ok: false, accepted: true, validation: error instanceof Error ? error.message : String(error), result: null, response: null };
  }
}

export function absoluteScore(scenario, local) {
  if (!local.accepted) return { pass: false, reason: "validation-rejected" };
  const result = local.result;
  if (!result || result.status !== scenario.expected.outcome) return { pass: false, reason: `expected ${scenario.expected.outcome}, received ${result?.status ?? "none"}` };
  const expected = expectedAnswers(scenario);
  const actual = scenario.canonicalInput.questions
    ? normalizedAnswers(local.response?.details?.answers)
    : result.answers.map((answer) => ({ questionIndex: answer.stageIndex, stageId: answer.stageId, kind: answer.kind, answer: answer.answer ?? null, ...(answer.optionLabels ? { selected: [...answer.optionLabels] } : {}) }));
  const pass = stableStringify(actual) === stableStringify(expected);
  return { pass, reason: pass ? "absolute-local-match" : "answer-mismatch" };
}

function runReference(scenarios) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./reference.mjs", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new BenchmarkError("reference_adapter_failed", stderr.trim() || "RPiV isolated adapter exited nonzero."));
      try { resolve(JSON.parse(stdout)); } catch (cause) { reject(new BenchmarkError("reference_adapter_failed", "RPiV adapter returned invalid JSON.", { cause })); }
    });
    child.stdin.end(JSON.stringify({ scenarios }));
  });
}

function scoreReference(scenario, reference, local) {
  if (!reference?.ok) return { pass: false, reason: reference?.error ?? "reference-failed", loss: true };
  const result = reference.result;
  const actual = normalizedAnswers(result.details?.answers);
  const expected = expectedAnswers(scenario);
  const answersMatch = stableStringify(actual) === stableStringify(expected);
  const referenceEnvelope = result.content?.[0]?.text;
  const referenceValidation = result.details?.error ? "rejected" : "accepted";
  const localEnvelope = local.response?.content?.[0]?.text;
  const envelopeMatch = typeof referenceEnvelope === "string" && referenceEnvelope === localEnvelope;
  return { pass: answersMatch && referenceValidation === "accepted" && envelopeMatch, reason: answersMatch ? (envelopeMatch ? "shared-match" : "envelope-unavailable") : "answer-mismatch", loss: true, answersMatch, referenceValidation };
}

export function blindLabels(seed, id) {
  let hash = seed >>> 0;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash & 1) === 0 ? { A: "candidate", B: "reference" } : { A: "reference", B: "candidate" };
}

export async function compareCorpus(corpus, { passes = 2, blind = false, seed = corpus.seed } = {}) {
  if (!Number.isInteger(passes) || passes < 1 || passes > 5) throw new BenchmarkError("invalid_passes", "--passes must be an integer from 1 through 5.");
  const shared = corpus.scenarios.filter((scenario) => scenario.comparisonScope === "shared");
  const reference = await runReference(shared);
  const referenceById = new Map(reference.output.map((item) => [item.id, item]));
  const cases = [];
  for (const scenario of corpus.scenarios) {
    const local = await runLocal(scenario);
    let score;
    if (scenario.comparisonScope === "shared") {
      const referenceScore = scoreReference(scenario, referenceById.get(scenario.id), local);
      score = { ...referenceScore, scoring: "shared-relative", localAbsolute: absoluteScore(scenario, local) };
    } else {
      score = { ...absoluteScore(scenario, local), scoring: "absolute-local-only", loss: false };
    }
    const labels = blind ? blindLabels(seed, scenario.id) : null;
    cases.push({ id: scenario.id, stratum: scenario.stratum, scope: scenario.comparisonScope, classification: scenario.classification, ...score, blindLabels: labels });
  }
  const successes = cases.filter((item) => item.pass).length;
  const sharedCases = cases.filter((item) => item.scope === "shared");
  const localOnlyCases = cases.filter((item) => item.scope === "local-only");
  const byStratum = Object.fromEntries(["ordinary", "visual", "adversarial"].map((stratum) => {
    const subset = cases.filter((item) => item.stratum === stratum);
    return [stratum, { total: subset.length, passed: subset.filter((item) => item.pass).length, accuracy: subset.length ? subset.filter((item) => item.pass).length / subset.length : 0 }];
  }));
  const report = {
    schemaVersion: SCHEMA_VERSION, kind: "benchmark-comparison", seed, passes, blind,
    reference: { adapter: reference.adapter, sharedOnly: true, rpivLossesExcludedForLocalOnly: true },
    summary: {
      total: cases.length, passed: successes, failed: cases.length - successes, deterministicAccuracy: successes / cases.length,
      wilson95LowerBound: wilsonLowerBound(successes, cases.length),
      shared: { total: sharedCases.length, passed: sharedCases.filter((item) => item.pass).length },
      localOnlyAbsolute: { total: localOnlyCases.length, passed: localOnlyCases.filter((item) => item.pass).length },
      byStratum,
    },
    cases,
  };
  assertNoCredentials(report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { corpus: "string", out: "string", passes: "number", blind: "boolean", seed: "number" });
  const corpus = normalizeCorpus(await readJson(args.corpus ?? DEFAULT_CORPUS, "corpus_missing"));
  const result = await compareCorpus(corpus, { passes: args.passes ?? 2, blind: args.blind === true, seed: parseSeed(args.seed, corpus.seed) });
  const out = await writeJson(args.out ?? ".pi/benchmark/results.json", result);
  process.stdout.write(`${JSON.stringify({ out, ...result.summary })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:compare: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
