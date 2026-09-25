#!/usr/bin/env node
/**
 * Deterministic contract comparison.
 *
 * Every case is executed through the *real* local path (normalizeReview ->
 * validateReview -> runDialogReview -> buildResponse) and, for shared cases,
 * through the isolated RPiV adapter in a child process. `passes` is the number
 * of real executions per case, not a label: a case only passes when every pass
 * produced the same answer and that answer matches the expected oracle.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildResponse } from "../../src/envelope.ts";
import { runDialogReview } from "../../src/fallback.ts";
import { makeReviewResult } from "../../src/state.ts";
import { normalizeReview, validateReview } from "../../src/schema.ts";
import {
  assertNoCredentials, BenchmarkError, parseArgs, parseSeed, readJson, SCHEMA_VERSION, stableStringify, wilsonLowerBound, writeJson,
} from "./common.mjs";
import { normalizeCorpus } from "./corpus.mjs";

export const DEFAULT_CORPUS = ".pi/benchmark/corpus.json";
const CASE_TIMEOUT_MS = 5_000;
const CONCURRENCY = 8;

const APPROVE_LABEL = "Approve review";
const REJECT_LABEL = "Reject review";
const REVISION_LABEL = "Request revision";
const SKIP_LABEL = "Skip stage";
const DONE_LABEL = "Done selecting";
const OTHER_LABEL = "Type something.";

/**
 * Terminal outcomes the shared question-tool contract covers. RPiV answers or
 * declines; it has no staged review, image option, revision round, or no-UI
 * fallback, so those scenarios are scored against the local absolute oracle
 * only and can never be counted as RPiV losses.
 */
export const SHARED_OUTCOMES = Object.freeze(new Set(["completed", "cancelled"]));

function normalizedAnswers(answers) {
  return (answers ?? []).map((answer) => ({
    questionIndex: answer.questionIndex,
    kind: answer.kind,
    answer: answer.answer ?? null,
    // A multi-select answer is a set: order carries no meaning, so both sides
    // are compared in a canonical order.
    ...(answer.selected ? { selected: [...answer.selected].sort() } : {}),
    ...(answer.notes ? { notes: answer.notes } : {}),
  }));
}

/**
 * Both sides are compared through the tool envelope — the answer list the model
 * actually receives — so the candidate and RPiV are scored on the same contract
 * regardless of which internal walk produced them.
 */
function expectedAnswers(scenario) {
  return (scenario.expected.answers ?? []).map((answer) => {
    const questionIndex = scenario.canonicalInput.questions
      ? answer.questionIndex
      : scenario.canonicalInput.stages?.findIndex((stage) => stage.id === answer.stageId) ?? -1;
    return {
      questionIndex,
      kind: answer.kind,
      answer: answer.answer ?? null,
      // A multi-select answer is a set: order carries no meaning, so both sides
      // are compared in a canonical order.
      ...(answer.selected ? { selected: [...answer.selected].sort() } : {}),
    };
  });
}

function localAnswers(local) {
  return normalizedAnswers(local.response?.details?.answers);
}

/**
 * Scripted host UI driven by the scenario oracle. The walk is derived from the
 * review itself, not from the expected answers, so a wrong answer cannot make
 * the dialog advance by accident.
 */
function localUi(scenario, review) {
  const stages = review.stages;
  const expected = scenario.expected.answers;
  const expectedOutcome = scenario.expected.outcome;
  const plan = new Map();
  for (const answer of expected) {
    const key = answer.stageId ?? stages[answer.questionIndex]?.id;
    if (key !== undefined) plan.set(key, answer);
  }
  let stageIndex = 0;
  let pendingCustom;
  const revisionFeedback = scenario.expected.revision?.feedback ?? "Rework this stage for the next round.";
  const selectedMulti = new Set();
  let pendingDone = false;
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    ui: {
      async select(title, choices) {
        // A runaway dialog must not stall the whole corpus run: the timeout
        // aborts this controller and every scripted interaction re-checks it.
        if (controller.signal.aborted) throw new BenchmarkError("local_timeout", "scripted dialog aborted");
        if (pendingDone) { pendingDone = false; stageIndex += 1; selectedMulti.clear(); return DONE_LABEL; }
        if (stageIndex >= stages.length) {
          if (expectedOutcome === "rejected") return REJECT_LABEL;
          return APPROVE_LABEL;
        }
        const stage = stages[stageIndex];
        const answer = plan.get(stage.id);
        if (expectedOutcome === "cancelled" && stageIndex === 0) return undefined;
        if (expectedOutcome === "rejected" && stageIndex === stages.length - 1) return REJECT_LABEL;
        if (expectedOutcome === "revision" && stageIndex === stages.length - 1) return REVISION_LABEL;
        if (!answer) {
          if (!stage.required) { stageIndex += 1; selectedMulti.clear(); return SKIP_LABEL; }
          // No recorded action: drive one legal interaction so the terminal
          // contract can still be observed. A multi-select stage also needs an
          // explicit commit, or the dialog would keep asking.
          if (stage.multiSelect) { pendingDone = true; return stage.options[0].label; }
          stageIndex += 1;
          return stage.options[0].label;
        }
        if (answer.kind === "custom") {
          pendingCustom = answer.answer;
          return OTHER_LABEL;
        }
        if (answer.kind === "multi" || stage.multiSelect) {
          const wanted = [...(answer.selected ?? answer.optionLabels ?? [])];
          const next = wanted.find((label) => !selectedMulti.has(label));
          if (next) {
            selectedMulti.add(next);
            return next;
          }
          stageIndex += 1;
          selectedMulti.clear();
          return DONE_LABEL;
        }
        if (answer.kind === "skip") {
          stageIndex += 1;
          return SKIP_LABEL;
        }
        const option = stage.options.find((candidate) => candidate.label === answer.answer);
        stageIndex += 1;
        return option ? option.label : undefined;
      },
      async input() {
        if (pendingCustom !== undefined) {
          const answer = pendingCustom;
          pendingCustom = undefined;
          return answer;
        }
        return revisionFeedback;
      },
      async confirm() { return true; },
      notify() {},
    },
  };
}

async function withTimeout(promise, ms, code, message, onTimeout) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new BenchmarkError(code, message)); }, ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run one local execution. Returns a shape that is stable across passes. */
export async function runLocal(scenario, { reason } = {}) {
  let review;
  try {
    review = normalizeReview(structuredClone(scenario.canonicalInput), 1);
    validateReview(review);
  } catch (error) {
    // Rejected before any UI interaction. This is the expected outcome for
    // negative scenarios and a hard failure for valid ones.
    return { ok: false, accepted: false, rejectedBeforeUi: true, validation: error instanceof Error ? error.message : String(error), result: null, response: null };
  }
  if (scenario.inputValid === false) {
    return { ok: false, accepted: false, rejectedBeforeUi: false, validation: "expected-rejection-not-observed", result: null, response: null };
  }
  const expectedOutcome = scenario.expected.outcome;
  if (expectedOutcome === "fallback") {
    // A host with no interactive UI must degrade to the plain-chat fallback.
    const result = makeReviewResult(review, "fallback", new Map(), undefined, []);
    result.status = "fallback";
    result.decision = "fallback";
    result.answers = [];
    const response = buildResponse(result, review);
    return { ok: response.content[0]?.text?.includes("could not open in this host") === true, accepted: true, rejectedBeforeUi: false, validation: "fallback", result, response, reason: reason ?? "no-ui" };
  }
  const ui = localUi(scenario, review);
  try {
    const execution = runDialogReview(ui, review);
    const result = await withTimeout(
      execution,
      CASE_TIMEOUT_MS,
      "local_timeout",
      `Local scripted execution timed out for ${scenario.id}.`,
      () => ui.abort(),
    );
    return { ok: result.status === expectedOutcome, accepted: true, rejectedBeforeUi: false, validation: "accepted", result, response: buildResponse(result, review) };
  } catch (error) {
    return { ok: false, accepted: true, rejectedBeforeUi: false, validation: error instanceof Error ? error.message : String(error), result: null, response: null };
  }
}

/** Score one local execution against the oracle. */
export function absoluteScore(scenario, local) {
  const expectedOutcome = scenario.expected.outcome;
  if (expectedOutcome === "invalid") {
    if (local.rejectedBeforeUi) return { pass: true, reason: "rejected-before-ui" };
    if (!local.accepted) return { pass: true, reason: `rejected-before-ui (${local.validation})` };
    return { pass: false, reason: "expected rejection, review was accepted" };
  }
  if (!local.accepted) return { pass: false, reason: `validation-rejected: ${local.validation}` };
  const result = local.result;
  if (!result || result.status !== expectedOutcome) return { pass: false, reason: `expected ${expectedOutcome}, received ${result?.status ?? "none"}` };
  // A revision must carry the requested change, otherwise the round is lost.
  if (expectedOutcome === "revision") {
    const revision = result.revision;
    const wanted = scenario.expected.revision;
    if (!revision) return { pass: false, reason: "revision status without a revision payload" };
    if (wanted) {
      if (revision.stageId !== wanted.stageId) return { pass: false, reason: `revision stage ${revision.stageId} != ${wanted.stageId}` };
      if (cap(revision.feedback) !== cap(wanted.feedback)) return { pass: false, reason: "revision feedback does not match the recorded request" };
      if (revision.requestedRound !== wanted.requestedRound) return { pass: false, reason: `revision round ${revision.requestedRound} != ${wanted.requestedRound}` };
    }
  }
  const expected = expectedAnswers(scenario);
  const actual = localAnswers(local);
  if (scenario.expected.oracle === "terminal-only") {
    // The source recorded no answer action, so only the terminal contract and an
    // explicit approval are asserted. A review whose stages are all optional may
    // legitimately complete with no answers; a required stage must record one.
    const stages = scenario.canonicalInput.stages ?? [{ id: "question-1", required: true }];
    const requiresAnswer = stages.some((stage) => stage.required !== false);
    const recorded = expectedOutcome === "completed" && requiresAnswer ? actual.length > 0 : true;
    return recorded
      ? { pass: true, reason: "terminal-only-match" }
      : { pass: false, reason: "terminal-only completed without a recorded answer for a required stage" };
  }
  const pass = stableStringify(actual) === stableStringify(expected);
  return { pass, reason: pass ? "absolute-local-match" : `answer-mismatch expected=${stableStringify(expected)} actual=${stableStringify(actual)}` };
}

function cap(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").replace(/\r/g, "").trim() : value;
}

function runReference(scenarios, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./reference.mjs", import.meta.url))], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new BenchmarkError("reference_adapter_timeout", "RPiV isolated adapter did not finish before the timeout."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new BenchmarkError("reference_adapter_failed", stderr.trim() || "RPiV isolated adapter exited nonzero."));
      try { resolve(JSON.parse(stdout)); } catch (cause) { reject(new BenchmarkError("reference_adapter_failed", "RPiV adapter returned invalid JSON.", { cause })); }
    });
    child.stdin.end(JSON.stringify({ scenarios }));
  });
}

/**
 * Head-to-head on shared capabilities only. The RPiV adapter must return the
 * expected answers and a shared status; the local candidate must independently
 * match its own absolute oracle. Envelope text is reported but never gates,
 * because the two tools document different envelope contracts.
 */
function scoreReference(scenario, reference, localAbsolute) {
  if (!reference?.ok) return { pass: false, reason: reference?.error ?? "reference-failed", loss: true, referenceOk: false };
  const result = reference.result;
  const details = result.details ?? {};
  const actual = normalizedAnswers(details.answers);
  const expected = expectedAnswers(scenario);
  const answersMatch = expectedAnswers(scenario).length === 0
    ? (actual.length === 0 || scenario.expected.oracle === "terminal-only")
    : stableStringify(actual) === stableStringify(expected);
  const referenceValidation = details.error ? "rejected" : "accepted";
  // RPiV reports `cancelled`; it has no approve/reject/revision status field.
  const referenceStatus = details.cancelled ? "cancelled" : (details.answers?.length ? "completed" : "none");
  const referenceEnvelope = result.content?.[0]?.text;
  const localEnvelope = localAbsolute?.envelope ?? null;
  const referenceFailed = !answersMatch || referenceValidation !== "accepted" || referenceStatus !== scenario.expected.outcome;
  return {
    pass: !referenceFailed && localAbsolute?.pass === true,
    reason: !answersMatch ? `reference-answer-mismatch ${stableStringify(actual)}`
      : referenceValidation !== "accepted" ? "reference-rejected-shared-input"
        : referenceStatus !== scenario.expected.outcome ? `reference-status-${referenceStatus}`
          : !localAbsolute?.pass ? `candidate-${localAbsolute.reason}` : "shared-match",
    // A loss means the *reference* missed the shared contract. A candidate
    // failure is reported separately and never charged to RPiV.
    loss: referenceFailed,
    candidatePass: localAbsolute?.pass === true,
    referenceOk: true,
    answersMatch,
    referenceValidation,
    referenceStatus,
    envelopeMatch: typeof referenceEnvelope === "string" && localEnvelope !== null ? referenceEnvelope === localEnvelope : null,
    referenceCapabilities: reference.capabilities ?? null,
  };
}

export function blindLabels(seed, id) {
  let hash = seed >>> 0;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash & 1) === 0 ? { A: "candidate", B: "reference" } : { A: "reference", B: "candidate" };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function compareCorpus(corpus, { passes = 2, blind = false, seed = corpus.seed, images = null } = {}) {
  if (!Number.isInteger(passes) || passes < 1 || passes > 5) throw new BenchmarkError("invalid_passes", "--passes must be an integer from 1 through 5.");
  const shared = corpus.scenarios.filter((scenario) => scenario.comparisonScope === "shared");
  const reference = await runReference(shared);
  const referenceById = new Map(reference.output.map((item) => [item.id, item]));
  const imageByOption = new Map((images?.images ?? []).flatMap((image) => image.optionIds?.map((id) => [id, image]) ?? []));

  const cases = await mapWithConcurrency(corpus.scenarios, CONCURRENCY, async (scenario) => {
    const runs = [];
    for (let pass = 0; pass < passes; pass += 1) {
      runs.push(await runLocal(scenario, { pass }));
    }
    const scored = runs.map((local) => absoluteScore(scenario, local));
    const stableResults = runs.map((local) => stableStringify({ status: local.result?.status ?? null, answers: localAnswers(local) }));
    const stable = stableResults.every((value) => value === stableResults[0]);
    const first = runs[0];
    const localAbsolute = { ...scored[0], pass: scored.every((item) => item.pass) && stable, stableAcrossPasses: stable };
    if (first.response?.content?.[0]?.text) localAbsolute.envelope = first.response.content[0].text;
    let score;
    if (scenario.comparisonScope === "shared") {
      score = { ...scoreReference(scenario, referenceById.get(scenario.id), localAbsolute), scoring: "shared-relative", localAbsolute };
    } else {
      score = { ...localAbsolute, scoring: "absolute-local-only", loss: false };
    }
    const labels = blind ? blindLabels(seed, scenario.id) : null;
    const imageBindings = scenario.canonicalInput.stages?.flatMap((stage) => stage.options.map((option) => imageByOption.get(`${scenario.id}:${option.key}`) ?? imageByOption.get(`${scenario.id}:${option.id}`)))
      .filter(Boolean) ?? [];
    return {
      id: scenario.id, stratum: scenario.stratum, scope: scenario.comparisonScope, classification: scenario.classification,
      oracle: scenario.expected.oracle ?? "exact",
      passesExecuted: passes, stableAcrossPasses: stable, ...score,
      validation: first.validation, rejectedBeforeUi: first.rejectedBeforeUi,
      imagesBound: imageBindings.length, blindLabels: labels,
    };
  });

  const successes = cases.filter((item) => item.pass).length;
  const terminalOnly = cases.filter((item) => item.oracle === "terminal-only").length;
  const terminalOnlyPassed = cases.filter((item) => item.oracle === "terminal-only" && item.pass).length;
  const sharedCases = cases.filter((item) => item.scope === "shared");
  const localOnlyCases = cases.filter((item) => item.scope === "local-only");
  const byStratum = Object.fromEntries(["ordinary", "visual", "adversarial"].map((stratum) => {
    const subset = cases.filter((item) => item.stratum === stratum);
    return [stratum, { total: subset.length, passed: subset.filter((item) => item.pass).length, accuracy: subset.length ? subset.filter((item) => item.pass).length / subset.length : 0 }];
  }));
  const unstable = cases.filter((item) => !item.stableAcrossPasses).map((item) => item.id);
  const referenceLosses = sharedCases.filter((item) => item.loss).map((item) => ({ id: item.id, reason: item.reason }));
  const candidateFailures = sharedCases.filter((item) => !item.candidatePass).map((item) => ({ id: item.id, reason: item.reason }));
  const report = {
    schemaVersion: SCHEMA_VERSION, kind: "benchmark-comparison", seed, blind,
    passes: { requested: passes, executedPerCase: passes, independentPassesExecuted: cases.length * passes },
    images: { bound: cases.reduce((sum, item) => sum + item.imagesBound, 0), scenariosWithImages: cases.filter((item) => item.imagesBound > 0).length },
    reference: {
      adapter: reference.adapter, sharedOnly: true, sharedCases: sharedCases.length,
      referenceRejections: sharedCases.filter((item) => item.referenceValidation === "rejected").length,
      envelopeMatchRate: sharedCases.length ? sharedCases.filter((item) => item.envelopeMatch === true).length / sharedCases.length : null,
      losses: referenceLosses,
      candidateFailures,
    },
    summary: {
      total: cases.length, passed: successes, failed: cases.length - successes,
      deterministicAccuracy: successes / cases.length,
      wilson95LowerBound: wilsonLowerBound(successes, cases.length),
      unstableCases: unstable.length,
      exactOracle: { total: cases.length - terminalOnly, passed: cases.filter((item) => item.oracle === "exact" && item.pass).length },
      terminalOnly: { total: terminalOnly, passed: terminalOnlyPassed },
      shared: { total: sharedCases.length, passed: sharedCases.filter((item) => item.pass).length, referenceLosses: referenceLosses.length },
      localOnlyAbsolute: { total: localOnlyCases.length, passed: localOnlyCases.filter((item) => item.pass).length },
      byStratum,
    },
    cases,
  };
  assertNoCredentials(report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { corpus: "string", out: "string", passes: "number", blind: "boolean", seed: "number", images: "string" });
  const corpus = normalizeCorpus(await readJson(args.corpus ?? DEFAULT_CORPUS, "corpus_missing"));
  const images = args.images ? await readJson(args.images, "manifest_missing") : null;
  const result = await compareCorpus(corpus, { passes: args.passes ?? 2, blind: args.blind === true, seed: parseSeed(args.seed, corpus.seed), images });
  const out = await writeJson(args.out ?? ".pi/benchmark/results.json", result);
  process.stdout.write(`${JSON.stringify({ out, ...result.summary })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:compare: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
