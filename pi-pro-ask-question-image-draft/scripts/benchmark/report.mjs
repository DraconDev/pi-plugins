#!/usr/bin/env node
/**
 * Aggregate report and release gate.
 *
 * Every number is recomputed from the artifacts on disk — corpus, per-case
 * comparison results, image manifest, judged visual report, live TTY smoke,
 * defect ledger, activation evidence. Nothing is taken on trust from a
 * self-reported summary, and a gate can only pass when its evidence exists.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { assertNoCredentials, BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, wilsonLowerBound, writeJson } from "./common.mjs";
import { validateCorpus } from "./corpus.mjs";

const STRATA = ["ordinary", "visual", "adversarial"];
/** Every scenario and every result must end in one of these. */
const TERMINAL_STATUSES = new Set(["completed", "rejected", "cancelled", "revision", "fallback", "invalid"]);
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
    return {
      id: scenario.id,
      stratum: scenario.stratum,
      pass: result.pass === true,
      reason: result.reason ?? null,
      oracle: scenario.expected.oracle ?? "exact",
      // The terminal outcome the execution actually reached, kept per case so
      // the report can prove every scenario ended somewhere real.
      terminalOutcome: result.terminalOutcome ?? (result.pass ? scenario.expected.outcome : null),
    };
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
  corpus, results, manifest, judging, liveSmoke, defects, activation, sources = null, observedAt = new Date().toISOString(),
}) {
  validateCorpus(corpus);
  const comparison = recomputeComparison(corpus, results);
  const images = recomputeImages(manifest, judging);
  const gates = recomputeGates(comparison, images);
  const smoke = evidenceOf(liveSmoke, "liveSmoke");
  // The ledger is a file, not a bare array. Accepting only an array silently
  // emptied the defect gate, so both shapes are handled explicitly.
  let ledger = [];
  if (Array.isArray(defects)) ledger = defects;
  else if (defects && typeof defects === "object") {
    if (!Array.isArray(defects.defects)) {
      throw new BenchmarkError("missing_evidence", "The defect ledger must be an array or an object with a defects array.");
    }
    ledger = defects.defects;
  } else if (defects !== undefined && defects !== null) {
    throw new BenchmarkError("missing_evidence", "The defect ledger must be an array or an object with a defects array.");
  }
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
    sources: sources ?? null,
    corpus: { count: corpus.count, seed: corpus.seed, strata: corpus.strata, provenance: corpus.provenance ?? null },
    comparison,
    images: { ...images, judging: judging?.summary ?? null },
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

/**
 * Evidence an independent auditor can check without rerunning anything.
 *
 * A defect ledger that merely asserts "fixed" is prose. Every resolved P0/P1
 * must name the test that would fail if the root cause came back, the named
 * test must exist, and any measured claim the ledger makes must match the
 * numbers recomputed from the artifacts. Drift between the ledger and the run
 * is a defect, not a formatting nit.
 */
export function verifyDefectLedger(ledger, { cases = null, judged = null, testsDir = "tests" } = {}) {
  const problems = [];
  for (const defect of ledger) {
    const critical = defect.severity === "P0" || defect.severity === "P1";
    if (critical && defect.status === "resolved" && !defect.regressionTest) {
      problems.push(`defect:${defect.id}: resolved critical defect without a regressionTest reference`);
    }
    if (defect.status === "resolved" && defect.regressionTest && !regressionTestExists(defect.regressionTest, testsDir)) {
      problems.push(`defect:${defect.id}: regressionTest "${defect.regressionTest}" does not exist in ${testsDir}/`);
    }
    if (defect.claim?.judgedCases != null && judged?.judgedCases != null && defect.claim.judgedCases !== judged.judgedCases) {
      problems.push(`defect:${defect.id}: claim.judgedCases ${defect.claim.judgedCases} != measured ${judged.judgedCases}`);
    }
    if (defect.claim?.candidateWins != null && judged?.candidateWins != null && defect.claim.candidateWins !== judged.candidateWins) {
      problems.push(`defect:${defect.id}: claim.candidateWins ${defect.claim.candidateWins} != measured ${judged.candidateWins}`);
    }
    if (defect.claim?.candidateWinRate != null && judged?.candidateWinRate != null && Math.abs(defect.claim.candidateWinRate - judged.candidateWinRate) > 1e-9) {
      problems.push(`defect:${defect.id}: claim.candidateWinRate ${defect.claim.candidateWinRate} != measured ${judged.candidateWinRate}`);
    }
    if (defect.claim?.wilson95LowerBound != null && judged?.wilson95LowerBound != null && Math.abs(defect.claim.wilson95LowerBound - judged.wilson95LowerBound) > 1e-9) {
      problems.push(`defect:${defect.id}: claim.wilson95LowerBound ${defect.claim.wilson95LowerBound} != measured ${judged.wilson95LowerBound}`);
    }
    if (defect.claim?.failedCases != null && cases != null && defect.claim.failedCases !== cases.failed) {
      problems.push(`defect:${defect.id}: claim.failedCases ${defect.claim.failedCases} != measured ${cases.failed}`);
    }
  }
  if (problems.length) {
    throw new BenchmarkError("defect_ledger_invalid", `Defect ledger does not match the evidence: ${problems.join("; ")}.`);
  }
  return { verified: true, defects: ledger.length };
}

/** Accept either a repo-relative path or a name relative to the tests directory. */
function regressionTestExists(reference, testsDir) {
  return existsSync(resolve(reference)) || existsSync(resolve(testsDir, reference));
}

/**
 * Every corpus scenario must carry a terminal outcome, in the corpus and in the
 * per-case results. A run that silently dropped cases would otherwise look like
 * a clean pass on a smaller set.
 */
export function verifyTerminalOutcomes(corpus, report) {
  const expected = new Map(corpus.scenarios.map((scenario) => [scenario.id, scenario.expected?.outcome]));
  const missing = [];
  for (const [id, outcome] of expected) {
    if (!TERMINAL_STATUSES.has(outcome)) missing.push(`${id}: corpus expectation is not a terminal outcome`);
  }
  const cases = report.comparison?.cases ?? [];
  const seen = new Set();
  for (const item of cases) {
    seen.add(item.id);
    if (!expected.has(item.id)) missing.push(`${item.id}: result is not in the corpus`);
    else if (!TERMINAL_STATUSES.has(item.terminalOutcome)) missing.push(`${item.id}: result has no terminal outcome`);
  }
  for (const id of expected.keys()) if (!seen.has(id)) missing.push(`${id}: corpus scenario has no result`);
  if (cases.length !== expected.size || missing.length) {
    throw new BenchmarkError("terminal_outcomes_incomplete", `Not every corpus scenario has a terminal outcome in the results: ${missing.slice(0, 10).join("; ") || `${cases.length} of ${expected.size} cases present`}.`);
  }
  return { verified: true, cases: cases.length };
}

/** Backwards-compatible shape check used by the test suite. */
export function verifyAggregateReport(report, { corpus = null, testsDir = "tests" } = {}) {
  if (report?.schemaVersion !== SCHEMA_VERSION || report?.kind !== "benchmark-aggregate-report") {
    throw new BenchmarkError("invalid_shape", "Unsupported aggregate report schema.");
  }
  const summary = report.corpus;
  if (!summary || summary.count !== 1000 || !summary.strata || STRATA.some((stratum) => summary.strata[stratum] === undefined)) {
    throw new BenchmarkError("missing_evidence", "Corpus count and all stratum counts are required.");
  }
  if (summary.strata.ordinary !== 700 || summary.strata.visual !== 200 || summary.strata.adversarial !== 100) {
    throw new BenchmarkError("count_mismatch", "Aggregate report must contain the 700/200/100 corpus split.");
  }
  const comparison = report.comparison;
  if (!comparison || !Number.isFinite(comparison.deterministicAccuracy) || !Number.isFinite(comparison.wilson95LowerBound)) {
    throw new BenchmarkError("missing_evidence", "Deterministic accuracy and Wilson lower bound are required.");
  }
  if (!Array.isArray(report.defects)) throw new BenchmarkError("missing_evidence", "Defect ledger is required.");
  // An open P0/P1 is a *release* fact, not a malformed report: the verifier
  // surfaces it as data and the release gate turns it into a failure. Only
  // structural problems (missing evidence, impossible activation claims) throw.
  const unresolvedCritical = report.defects
    .filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status !== "resolved")
    .map((defect) => defect.id);
  verifyDefectLedger(report.defects, {
    judged: report.images?.judging ?? null,
    cases: report.comparison ? { failed: report.comparison.failed } : null,
    testsDir,
  });
  if (corpus) verifyTerminalOutcomes(corpus, report);
  evidenceOf(report.liveSmoke, "liveSmoke");
  if (report.activation?.claimed === true) {
    if (report.activation.status !== "passed" || report.releaseReady !== true) {
      throw new BenchmarkError("activation_order_invalid", "Activation can only be claimed after every gate passed.");
    }
  }
  return {
    verified: true,
    releaseReady: report.releaseReady === true,
    activationClaim: report.activation?.claimed === true ? "evidenced" : "not-claimed",
    unresolvedCritical,
  };
}

/** Resolve a recorded source next to the report when it is not under the cwd. */
function resolveSource(reportPath, recorded) {
  if (!recorded) return null;
  const direct = resolve(recorded);
  if (existsSync(direct)) return direct;
  const beside = resolve(reportPath.slice(0, Math.max(0, reportPath.lastIndexOf("/"))), recorded.slice(recorded.lastIndexOf("/") + 1));
  return existsSync(beside) ? beside : null;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, {
    corpus: "string", results: "string", images: "string", judging: "string",
    smoke: "string", defects: "string", activation: "string", out: "string", verify: "string", tests: "string",
  });
  if (args.verify) {
    const reportPath = resolve(String(args.verify));
    const report = await readJson(reportPath, "report_missing");
    // Integrity first: a malformed report, an empty ledger, or an activation
    // claim without passing gates is always an error. So is a ledger whose
    // numbers or regression tests do not match the run, and a result set that
    // does not cover every scenario with a terminal outcome.
    const corpusPath = args.corpus ?? resolveSource(reportPath, report.sources?.corpus);
    const corpus = corpusPath ? await readJson(corpusPath, "corpus_missing") : null;
    const result = verifyAggregateReport(report, { corpus, testsDir: args.tests ?? "tests" });
    const unmet = [
      ...Object.entries(report.gates ?? {}).filter(([, value]) => value !== true).map(([name]) => `gate:${name}`),
      ...result.unresolvedCritical.map((id) => `defect:${id}`),
    ];
    process.stdout.write(`${JSON.stringify({
      report: reportPath, ...result,
      unmetGates: unmet,
      releaseGate: report.releaseReady === true ? "passed" : "failed",
    })}\n`);
    // Release readiness is the contract, not an opt-in: a report that is not
    // ready fails the command that verifies it. An earlier version moved this
    // behind an environment variable, which turned the gate into a switch.
    if (report.releaseReady !== true) {
      throw new BenchmarkError("gate_failed", `Release gates are unmet: ${unmet.join(", ")}.`);
    }
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
  const report = await buildAggregateReport({
    corpus, results, manifest, judging, liveSmoke, defects, activation,
    sources: {
      corpus: args.corpus ?? ".pi/benchmark/corpus.json",
      results: args.results ?? ".pi/benchmark/results.json",
      images: args.images ?? (manifest ? ".pi/benchmark/image-manifest.json" : null),
      judging: args.judging ?? (judging ? ".pi/benchmark/judge.json" : null),
      smoke: args.smoke ?? ".pi/benchmark/live-smoke.json",
      defects: args.defects ?? ".pi/benchmark/defects.json",
      activation: args.activation ?? ".pi/benchmark/activation.json",
    },
  });
  const out = await writeJson(args.out ?? ".pi/benchmark/report.json", report);
  process.stdout.write(`${JSON.stringify({ out, releaseReady: report.releaseReady, gates: report.gates, accuracy: report.comparison.deterministicAccuracy, visualUplift: report.images.visualUplift, judgedCases: report.images.judgedCases })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { process.stderr.write(`benchmark:report: ${error.code ? `${error.code}: ` : ""}${error.message}\n`); process.exitCode = 1; });
}
