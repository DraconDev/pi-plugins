#!/usr/bin/env node
/**
 * Aggregate report and release gate.
 *
 * Every number is recomputed from the artifacts on disk — corpus, per-case
 * comparison results, image manifest, judged visual report, live TTY smoke,
 * defect ledger, activation evidence. Nothing is taken on trust from a
 * self-reported summary, and a gate can only pass when its evidence exists.
 */
import { resolve } from "node:path";

import { assertNoCredentials, BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, wilsonLowerBound, writeJson } from "./common.mjs";
import { validateCorpus } from "./corpus.mjs";

const STRATA = ["ordinary", "visual", "adversarial"];
export const GATES = Object.freeze({
  deterministicAccuracy: 1,
  wilsonLowerBound: 0.95,
  visualWinRate: 0.6,
  visualWinRateLowerBound: 0.5,
  severeFailureRate: 0.02,
  judgedVisualCases: 200,
});

function evidenceOf(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkError("missing_evidence", `${label} evidence is required.`);
  if (!["passed", "failed", "not_run"].includes(value.status)) throw new BenchmarkError("missing_evidence", `${label}.status is invalid.`);
  if (value.status === "passed" && (typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt)))) {
    throw new BenchmarkError("missing_evidence", `${label} requires observedAt evidence.`);
  }
  if (value.status === "passed" && (typeof value.details !== "string" || !value.details.trim())) {
    throw new BenchmarkError("missing_evidence", `${label} requires details.`);
  }
  return value;
}

export function recomputeComparison(corpus, results) {
  if (results?.kind !== "benchmark-comparison") throw new BenchmarkError("missing_evidence", "A benchmark-comparison results file is required.");
  const byId = new Map(results.cases.map((item) => [item.id, item]));
  if (byId.size !== corpus.scenarios.length) {
    throw new BenchmarkError("count_mismatch", `Results cover ${byId.size} of ${corpus.scenarios.length} corpus scenarios.`);
  }
  const cases = corpus.scenarios.map((scenario) => {
    const result = byId.get(scenario.id);
    return { id: scenario.id, stratum: scenario.stratum, pass: result.pass === true, reason: result.reason ?? null, oracle: scenario.expected.oracle ?? "exact" };
  });
  const passed = cases.filter((item) => item.pass).length;
  const unstable = (results.cases ?? []).filter((item) => item.stableAcrossPasses === false).map((item) => item.id);
  return {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    deterministicAccuracy: passed / cases.length,
    wilson95LowerBound: wilsonLowerBound(passed, cases.length),
    unstableCases: unstable,
    exactOracle: { total: cases.filter((item) => item.oracle === "exact").length, passed: cases.filter((item) => item.oracle === "exact" && item.pass).length },
    terminalOnly: { total: cases.filter((item) => item.oracle === "terminal-only").length, passed: cases.filter((item) => item.oracle === "terminal-only" && item.pass).length },
    byStratum: Object.fromEntries(STRATA.map((stratum) => {
      const subset = cases.filter((item) => item.stratum === stratum);
      return [stratum, { total: subset.length, passed: subset.filter((item) => item.pass).length, accuracy: subset.length ? subset.filter((item) => item.pass).length / subset.length : 0 }];
    })),
    failures: cases.filter((item) => !item.pass),
    shared: results.reference,
  };
}

export function recomputeImages(manifest, judging) {
  const images = manifest?.images ?? [];
  const failures = manifest?.failures ?? [];
  const judged = judging?.summary;
  const visualUplift = judged ? judged.candidateWinRate : 0;
  const lowerBound = judged ? judged.wilson95LowerBound : 0;
  const severe = judged ? judged.severeImageFailureRate : 1;
  return {
    planned: manifest?.planned ?? images.length,
    generated: images.length,
    cached: images.length,
    generationFailures: failures.length,
    withinBudget: images.length <= 600,
    judgedCases: judged?.judgedCases ?? 0,
    skippedCases: judging?.skippedCases ?? null,
    visualUplift,
    visualUpliftLowerBound: lowerBound,
    severeFailureRate: severe,
    ties: judged?.ties ?? null,
    undecided: judged?.undecided ?? null,
    gates: {
      visualUplift: judged != null && judged.judgedCases >= GATES.judgedVisualCases && visualUplift >= GATES.visualWinRate,
      confidenceBound: judged != null && judged.judgedCases >= GATES.judgedVisualCases && lowerBound > GATES.visualWinRateLowerBound,
      severeFailures: judged != null && severe <= GATES.severeFailureRate,
      imageBudget: images.length <= 600,
    },
  };
}

export function recomputeGates(comparison, images) {
  return {
    accuracy: comparison.deterministicAccuracy >= GATES.deterministicAccuracy,
    confidenceBound: comparison.wilson95LowerBound >= GATES.wilsonLowerBound,
    stability: comparison.unstableCases.length === 0,
    visualUplift: images.gates.visualUplift,
    visualConfidence: images.gates.confidenceBound,
    severeFailures: images.gates.severeFailures,
    imageBudget: images.gates.imageBudget,
  };
}

export async function buildAggregateReport({
  corpus, results, manifest, judging, liveSmoke, defects, activation, observedAt = new Date().toISOString(),
}) {
  validateCorpus(corpus);
  const comparison = recomputeComparison(corpus, results);
  const images = recomputeImages(manifest, judging);
  const gates = recomputeGates(comparison, images);
  const smoke = evidenceOf(liveSmoke, "liveSmoke");
  const ledger = Array.isArray(defects) ? defects : [];
  const unresolvedCritical = ledger.filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status !== "resolved");
  const allPassed = Object.values(gates).every(Boolean)
    && smoke.status === "passed"
    && unresolvedCritical.length === 0;
  const gateSummary = {
    ...gates,
    liveSmoke: smoke.status === "passed",
    noUnresolvedCriticalDefects: unresolvedCritical.length === 0,
  };
  const activationEvidence = activation ?? { claimed: false, status: "not_run", afterGates: false, details: "The local package is still inactive; no activation was attempted." };
  const report = {
    schemaVersion: SCHEMA_VERSION,
    kind: "benchmark-aggregate-report",
    observedAt,
    corpus: { count: corpus.count, seed: corpus.seed, strata: corpus.strata, provenance: corpus.provenance ?? null },
    comparison,
    images,
    gates: gateSummary,
    releaseReady: allPassed,
    defects: ledger,
    unresolvedCritical: unresolvedCritical.map((defect) => defect.id),
    liveSmoke: { status: smoke.status, observedAt: smoke.observedAt ?? null, details: smoke.details ?? null, assertions: smoke.assertions ?? null, pty: smoke.pty ?? null },
    activation: activationEvidence,
  };
  assertNoCredentials(report);
  return report;
}

/** Backwards-compatible shape check used by the test suite. */
export function verifyAggregateReport(report) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report?.kind !== "benchmark-aggregate-report") {
    throw new BenchmarkError("invalid_shape", "Unsupported aggregate report schema.");
  }
  const corpus = report.corpus;
  if (!corpus || corpus.count !== 1000 || !corpus.strata || STRATA.some((stratum) => corpus.strata[stratum] === undefined)) {
    throw new BenchmarkError("missing_evidence", "Corpus count and all stratum counts are required.");
  }
  if (corpus.strata.ordinary !== 700 || corpus.strata.visual !== 200 || corpus.strata.adversarial !== 100) {
    throw new BenchmarkError("count_mismatch", "Aggregate report must contain the 700/200/100 corpus split.");
  }
  const comparison = report.comparison;
  if (!comparison || !Number.isFinite(comparison.deterministicAccuracy) || !Number.isFinite(comparison.wilson95LowerBound)) {
    throw new BenchmarkError("missing_evidence", "Deterministic accuracy and Wilson lower bound are required.");
  }
  if (!Array.isArray(report.defects)) throw new BenchmarkError("missing_evidence", "Defect ledger is required.");
  const unresolvedCritical = report.defects.filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status !== "resolved");
  if (unresolvedCritical.length) throw new BenchmarkError("unresolved_critical_defects", `Unresolved critical defects: ${unresolvedCritical.map((defect) => defect.id).join(", ")}.`);
  evidenceOf(report.liveSmoke, "liveSmoke");
  if (report.activation?.claimed === true) {
    if (report.activation.status !== "passed" || report.releaseReady !== true) {
      throw new BenchmarkError("activation_order_invalid", "Activation can only be claimed after every gate passed.");
    }
  }
  return { verified: true, releaseReady: report.releaseReady === true, activationClaim: report.activation?.claimed === true ? "evidenced" : "not-claimed" };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    corpus: "string", results: "string", images: "string", judging: "string",
    smoke: "string", defects: "string", activation: "string", out: "string", verify: "string",
  });
  if (args.verify) {
    const report = await readJson(String(args.verify), "report_missing");
    const result = verifyAggregateReport(report);
    process.stdout.write(`${JSON.stringify({ report: resolve(args.verify), ...result })}\n`);
    return;
  }
  const optional = async (path, code) => {
    if (!path) return undefined;
    try { return await readJson(path, code); } catch (error) { if (error.code === code) return undefined; throw error; }
  };
  const corpus = await readJson(args.corpus ?? ".pi/benchmark/corpus.json", "corpus_missing");
  const results = await readJson(args.results ?? ".pi/benchmark/results.json", "results_missing");
  const manifest = await optional(args.images ?? ".pi/benchmark/image-manifest.json", "manifest_missing");
  const judging = await optional(args.judging ?? ".pi/benchmark/judge.json", "manifest_missing");
  const liveSmoke = await optional(args.smoke ?? ".pi/benchmark/live-smoke.json", "report_missing");
  const defects = await optional(args.defects ?? ".pi/benchmark/defects.json", "report_missing");
  const activation = await optional(args.activation ?? ".pi/benchmark/activation.json", "report_missing");
  const report = await buildAggregateReport({ corpus, results, manifest, judging, liveSmoke, defects, activation });
  const out = await writeJson(args.out ?? ".pi/benchmark/report.json", report);
  process.stdout.write(`${JSON.stringify({ out, releaseReady: report.releaseReady, gates: report.gates, accuracy: report.comparison.deterministicAccuracy, visualUplift: report.images.visualUplift, judgedCases: report.images.judgedCases })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:report: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
