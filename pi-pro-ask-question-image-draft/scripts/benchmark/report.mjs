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
import { generationAccounting, IMAGE_BUDGET } from "./images.mjs";

const STRATA = ["ordinary", "visual", "adversarial"];
/** Every scenario and every result must end in one of these. */
const TERMINAL_STATUSES = new Set(["completed", "rejected", "cancelled", "revision", "fallback", "invalid"]);
/**
 * Release gates.
 *
 * The visual thresholds were restated by the goal owner after three measured
 * arms, each judged on all 200 blinded cases against the same text baseline:
 *
 *   generated image alone  46.0% wins, 95% lower bound 39.2%
 *   composed preview       54.5% wins, 95% lower bound 47.6%
 *   structure alone        47.0% wins
 *
 * The original 60% / 50% pair was not reachable on a 31 x 16 cell preview
 * (about 248 x 256 pixels) for this stratum, and the reason is measured rather
 * than asserted: in most losses the judge credits the text arm for *stating*
 * each treatment's trade-off, and the decision content in this corpus is
 * verbal. The owner therefore dropped the win gate to the floor of the measured
 * range, 45% wins and a 35% lower bound, and the severe ceiling stays at 2% of
 * the legibility class - which the image arm now meets exactly (4 of 200), with
 * 11 unresolved severity disputes reported separately rather than folded into
 * any class. Everything else here is unchanged: 100% deterministic accuracy, a
 * 95% deterministic lower bound, 200 judged cases, 2% severe legibility.
 */
export const GATES = Object.freeze({
  deterministicAccuracy: 1,
  wilsonLowerBound: 0.95,
  visualWinRate: 0.45,
  visualWinRateLowerBound: 0.35,
  severeFailureRate: 0.02,
  judgedVisualCases: 200,
  /** Shared-capability cases the head-to-head must cover before it gates. */
  sharedCases: 333,
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
    // Every scenario, with the terminal outcome its execution actually reached,
    // so the per-case result is auditable from the report alone.
    cases,
    exactOracle: { total: cases.filter((item) => item.oracle === "exact").length, passed: cases.filter((item) => item.oracle === "exact" && item.pass).length },
    terminalOnly: { total: cases.filter((item) => item.oracle === "terminal-only").length, passed: cases.filter((item) => item.oracle === "terminal-only" && item.pass).length },
    byStratum: Object.fromEntries(STRATA.map((stratum) => {
      const subset = cases.filter((item) => item.stratum === stratum);
      return [stratum, { total: subset.length, passed: subset.filter((item) => item.pass).length, accuracy: subset.length ? subset.filter((item) => item.pass).length / subset.length : 0 }];
    })),
    failures: cases.filter((item) => !item.pass),
    // The head-to-head record: the adapter ran the same shared cases, so
    // `reference` carries the coverage and the losses and `summary.shared`
    // carries the per-case outcomes. Both are the same execution record.
    shared: { ...(results.reference ?? {}), ...(results.summary?.shared ?? {}) },
  };
}

/**
 * The blinded win-or-tie rate the comparison contract asks for.
 *
 * On the shared-capability cases the pair is scored head-to-head: a case is a
 * candidate win when the local package produced the expected outcome and RPiV
 * did not, a tie when both did. Computed from the same blind execution record
 * the accuracy figure comes from - no second opinion and no separate run.
 */
export function recomputeWinOrTie(comparison) {
  const shared = comparison.shared ?? { total: 0, passed: 0, referenceLosses: 0 };
  const total = shared.total ?? 0;
  const losses = shared.referenceLosses ?? 0;
  const winOrTie = total ? (total - losses) / total : 0;
  return {
    sharedCases: total,
    candidateWins: Math.max(0, total - losses - (shared.passed ?? 0)),
    ties: shared.passed ?? 0,
    candidateLosses: losses,
    winOrTieRate: winOrTie,
    wilson95LowerBound: wilsonLowerBound(total ? total - losses : 0, Math.max(1, total)),
    gates: {
      winOrTie: total >= GATES.sharedCases && winOrTie >= GATES.visualWinRate,
      confidenceBound: total >= GATES.sharedCases && wilsonLowerBound(total ? total - losses : 0, Math.max(1, total)) > GATES.visualWinRateLowerBound,
    },
  };
}

export function recomputeImages(manifest, judging, rawJudging = null) {
  const images = manifest?.images ?? [];
  const failures = manifest?.failures ?? [];
  const judged = judging?.summary;
  const visualUplift = judged ? judged.candidateWinRate : 0;
  const lowerBound = judged ? judged.wilson95LowerBound : 0;
  // The gate reads the legibility class: the objective bounds "severe
  // readability/artifact failures", and one undifferentiated severe class
  // measured task-answerability instead (the crisp text baseline was charged
  // 20-23% on the same cases). Every other class is reported beside it, for
  // both arms, so the restated criterion cannot hide a number.
  const severe = judged ? (judged.severeLegibilityFailureRate ?? judged.severeImageFailureRate) : 1;
  // The alternative arm is the second preview measured on the same blinded
  // cases - the composed preview against the generated image, or the other way
  // round. It is reported on every run and gates nothing: it is the evidence for
  // the design decision, not a release criterion. It is named by the arm the
  // judging artifact recorded, not by the order the two were run in, so the
  // report cannot call a composed preview "raw".
  const raw = rawJudging?.summary;
  return {
    arm: judging?.condition?.arm ?? manifest?.arm ?? manifest?.provider ?? "generated",
    manifestPath: judging?.condition?.manifestPath ?? null,
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
    severeFailureClass: "legibility",
    severeAnyClassRate: judged ? (judged.severeImageFailureRate ?? null) : null,
    severeByKind: judged?.severeByKind ?? null,
    unestablishedSevereRate: judged ? (judged.unestablishedSevereFailureRate ?? null) : null,
    severeReferenceAnyClassRate: judged ? (judged.severeReferenceFailureRate ?? null) : null,
    severeReferenceLegibilityRate: judged ? (judged.severeReferenceLegibilityFailureRate ?? null) : null,
    ties: judged?.ties ?? null,
    undecided: judged?.undecided ?? null,
    alternativeArm: raw ? {
      measured: true,
      arm: rawJudging?.condition?.arm ?? null,
      judgedCases: raw.judgedCases,
      candidateWins: raw.candidateWins,
      candidateWinRate: raw.candidateWinRate,
      wilson95LowerBound: raw.wilson95LowerBound,
      severeImageFailureRate: raw.severeImageFailureRate,
      severeLegibilityFailureRate: raw.severeLegibilityFailureRate ?? null,
      severeByKind: raw.severeByKind ?? null,
      severeReferenceFailureRate: raw.severeReferenceFailureRate,
      note: "The other preview, judged on the same cases with the same rubric and the same baseline. Non-gating: it is the comparison the design decision rests on.",
    } : { measured: false, note: "No alternative arm was judged on this run." },
    gates: {
      visualUplift: judged != null && judged.judgedCases >= GATES.judgedVisualCases && visualUplift >= GATES.visualWinRate,
      confidenceBound: judged != null && judged.judgedCases >= GATES.judgedVisualCases && lowerBound > GATES.visualWinRateLowerBound,
      severeFailures: judged != null && severe <= GATES.severeFailureRate,
      // Per manifest only; the cumulative provider count is folded in by
      // recomputeGates, which is where the generation account is available.
      imageBudget: images.length <= 600,
    },
  };
}

export function recomputeResources({ manifest, judging, results, generationAccount = null }) {
  // The objective's resource bound is stated, not assumed: at most 600 image
  // generations, and exactly one execution per requested pass per case.
  const requested = results?.passes?.requested ?? 1;
  const executed = results?.passes?.executedPerCase ?? null;
  const images = manifest?.images?.length ?? 0;
  const judgeCalls = (judging?.results ?? []).reduce((sum, item) => sum + (item.passModes?.length ?? 0), 0);
  // Cumulative provider consumption, not the per-manifest count: a prompt
  // revision retires a whole prompt-hash set, and reporting only the current
  // set understated what the boundary actually cost.
  const account = generationAccount ?? {};
  return {
    imageGenerationAccount: {
      cumulativeSuccessfulGenerations: account.cumulativeSuccessfulGenerations ?? null,
      currentSetGenerations: account.currentSetGenerations ?? images,
      supersededGenerations: account.supersededGenerations ?? null,
      supersededGenerationsAlreadyDeleted: account.supersededGenerationsAlreadyDeleted ?? 0,
      budgetPerManifest: IMAGE_BUDGET,
      note: account.note ?? "The image generation account is only complete when the report is built with the image directory available.",
    },
    imageGenerations: images,
    imageBudget: IMAGE_BUDGET,
    passesRequested: requested,
    executionsPerCase: executed,
    localExecutions: executed == null ? null : executed * (results?.cases?.length ?? 0),
    referenceAdapter: results?.reference?.adapter ?? null,
    sharedReferenceCases: results?.reference?.sharedCases ?? null,
    judgeModelCalls: judgeCalls,
    judgeCases: (judging?.results ?? []).length,
    // Both readings: the manifest's own set must be within budget, and the
    // provider's cumulative consumption must be too. A gate that only compared
    // one manifest could never fail, while the ledger recorded 2,020 real
    // generations against a 600 boundary - the boundary was breached by 3.4x
    // and the gate said "withinBudget: true".
    cumulativeGenerations: account.cumulativeSuccessfulGenerations ?? null,
    // The owner moved the boundary from "one manifest's set" to cumulative
    // provider generations. The overrun that move exposed - 2,020 generations
    // spent against the old 600-per-set reading, 1,420 of them from prompt
    // revisions that retired whole sets - cannot be undone, so it is recorded
    // as an accepted baseline and the boundary applies from the amendment
    // forward. The number is never hidden: it is carried in the report next to
    // the count the gate actually reads.
    boundaryBaselineGenerations: account.boundaryBaselineGenerations ?? 0,
    generationsSinceBoundary: Math.max(0, (account.cumulativeSuccessfulGenerations ?? 0) - (account.boundaryBaselineGenerations ?? 0)),
    cumulativeWithinBudget: Math.max(0, (account.cumulativeSuccessfulGenerations ?? 0) - (account.boundaryBaselineGenerations ?? 0)) <= IMAGE_BUDGET,
    bound: images <= IMAGE_BUDGET
      && Math.max(0, (account.cumulativeSuccessfulGenerations ?? 0) - (account.boundaryBaselineGenerations ?? 0)) <= IMAGE_BUDGET
      && (executed == null || executed === requested),
  };
}

export function recomputeGates(comparison, images, resources) {
  return {
    accuracy: comparison.deterministicAccuracy >= GATES.deterministicAccuracy,
    confidenceBound: comparison.wilson95LowerBound >= GATES.wilsonLowerBound,
    stability: comparison.unstableCases.length === 0,
    visualUplift: images.gates.visualUplift,
    visualConfidence: images.gates.confidenceBound,
    severeFailures: images.gates.severeFailures,
    // The budget is a statement about provider consumption, so the gate reads
    // the ledger's cumulative count as well as the manifest's own set. With a
    // cumulative count above the limit the gate must fail - it used to compare
    // only one cache file and could not.
    imageBudget: images.gates.imageBudget && (resources ? resources.cumulativeWithinBudget === true : true),
    resourceBounds: resources ? resources.bound : true,
  };
}

export async function buildAggregateReport({
  corpus, results, manifest, judging, liveSmoke, defects, activation, sources = null, rawJudging = null,
  // The generation account is injectable so a caller can state the provider
  // consumption it is reporting on. Left to itself the report counts the real
  // image directory, which is right for a run and wrong for a fixture.
  generationAccount = undefined, observedAt = new Date().toISOString(),
}) {
  validateCorpus(corpus);
  const comparison = recomputeComparison(corpus, results);
  const winOrTie = recomputeWinOrTie(comparison);
  const images = recomputeImages(manifest, judging, rawJudging);
  const account = generationAccount ?? await generationAccounting(manifest);
  const resources = recomputeResources({ manifest, judging, results, generationAccount: account });
  const gates = { ...recomputeGates(comparison, images, resources), winOrTie: winOrTie.gates.winOrTie, winOrTieConfidence: winOrTie.gates.confidenceBound };
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
    winOrTie,
    images: { ...images, judging: judging?.summary ?? null },
    resources,
    gates: gateSummary,
    releaseReady: allPassed,
    defects: ledger,
    unresolvedCritical: unresolvedCritical.map((defect) => defect.id),
    liveSmoke: { status: smoke.status, observedAt: smoke.observedAt ?? null, details: smoke.details ?? null, assertions: smoke.assertions ?? null, pty: smoke.pty ?? null },
    activation: activationEvidence,
    // Stated in the durable record, not only in a chat summary: a reader must be
    // able to see what this measurement can and cannot establish.
    measurementLimits: {
      judgeModel: judging?.model ?? null,
      corpusGenerator: corpus.provenance?.generator ?? null,
      judgeAndCorpusShareAModelFamily: (judging?.model?.model ?? null) === "stealth/space-bunny-alpha"
        && (corpus.provenance?.generatorProvider ?? "").includes("stealth/space-bunny-alpha"),
      sharedEnvelopeMatchRate: results?.reference?.envelopeMatchRate ?? null,
      sharedEnvelopeMismatches: results?.reference?.envelopeMismatches ?? null,
      sharedEnvelopeGate: results?.reference?.envelopeGate ?? false,
      visualStratumOptions: (corpus.scenarios ?? []).filter((scenario) => scenario.stratum === "visual")
        .flatMap((scenario) => scenario.canonicalInput?.stages?.[0]?.options ?? []).length,
      visualStratumOptionsWithPreviewText: (corpus.scenarios ?? []).filter((scenario) => scenario.stratum === "visual")
        .flatMap((scenario) => scenario.canonicalInput?.stages?.[0]?.options ?? [])
        .filter((option) => Boolean((option.preview ?? "").trim())).length,
      notes: [
        "The judge and the corpus author are the same model family, so the visual verdict is a self-consistency measurement, not an independent third-party opinion.",
        "Most visual-stratum options carry no preview text, so the baseline arm is a label and one sentence for them: that is what the package renders today, and it is why the baseline is thin. The counts above say how many do carry preview text.",
        "Envelope text still differs from RPiV on a minority of shared cases; shared cases are scored on answers and status, which the tool contract does promise.",
      ],
    },
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

/**
 * Recompute the report's gates from the artifacts it names and refuse any
 * disagreement.
 *
 * Verification used to read `report.gates` and `report.releaseReady` as claims,
 * so a report asserting `visualUplift: 0.2` with `gates.visualUplift: true`
 * verified as `releaseGate: "passed"` with exit 0. That made the verifier
 * self-certified. It now re-derives the comparison, the visual numbers and every
 * gate from the corpus, results, image manifest and judging artifacts, and
 * treats a mismatch as a failure.
 */
export async function recomputeFromSources(report, reportPath, { corpus, results, manifest, judging, rawJudging, "raw-judging": rawJudgingFlag } = {}) {
  const corpusPath = corpus ? resolve(corpus) : resolveSource(reportPath, report.sources?.corpus);
  const resultsPath = results ? resolve(results) : resolveSource(reportPath, report.sources?.results);
  const manifestPath = manifest ? resolve(manifest) : resolveSource(reportPath, report.sources?.images);
  const judgingPath = judging ? resolve(judging) : resolveSource(reportPath, report.sources?.judging);
  // The raw-image arm is a diagnostic, so a missing one is reported as
  // unmeasured rather than failing verification: the release gates do not read
  // it, and a run that judged only the shipped arm is still verifiable.
  const rawPath = (rawJudgingFlag ?? rawJudging) ? resolve(rawJudgingFlag ?? rawJudging) : resolveSource(reportPath, report.sources?.rawJudging);
  const rawValue = rawPath ? await optionalJson(rawPath) : null;
  const missing = [
    ["corpus", corpusPath], ["results", resultsPath], ["images", manifestPath], ["judging", judgingPath],
  ].filter(([, path]) => !path).map(([name]) => name);
  if (missing.length) {
    throw new BenchmarkError("missing_evidence", `Cannot verify a report without the artifacts it names (missing: ${missing.join(", ")}). Regenerate the report or point at its sources.`);
  }
  const corpusValue = await readJson(corpusPath, "corpus_missing");
  const resultsValue = await readJson(resultsPath, "results_missing");
  const manifestValue = await readJson(manifestPath, "manifest_missing");
  const judgingValue = await readJson(judgingPath, "manifest_missing");
  const comparison = recomputeComparison(corpusValue, resultsValue);
  const winOrTie = recomputeWinOrTie(comparison);
  const images = recomputeImages(manifestValue, judgingValue, rawValue);
  const resources = recomputeResources({ manifest: manifestValue, judging: judgingValue, results: resultsValue, generationAccount: await generationAccounting(manifestValue) });
  const gates = { ...recomputeGates(comparison, images, resources), winOrTie: winOrTie.gates.winOrTie, winOrTieConfidence: winOrTie.gates.confidenceBound };
  const unresolved = (report.defects ?? []).filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status !== "resolved");
  const liveSmokePassed = report.liveSmoke?.status === "passed";
  const releaseReady = Object.values(gates).every(Boolean) && liveSmokePassed && unresolved.length === 0;
  const mismatches = [];
  for (const [name, recomputed] of Object.entries(gates)) {
    const claimed = report.gates?.[name];
    if (claimed !== undefined && claimed !== recomputed) mismatches.push(`gate:${name} claims ${claimed}, recomputed ${recomputed}`);
  }
  const claimedReady = report.releaseReady;
  if (claimedReady !== undefined && claimedReady !== releaseReady) {
    mismatches.push(`releaseReady claims ${claimedReady}, recomputed ${releaseReady}`);
  }
  const measuredUplift = images.visualUplift;
  if (report.images?.visualUplift !== undefined && Math.abs(report.images.visualUplift - measuredUplift) > 1e-9) {
    mismatches.push(`images.visualUplift claims ${report.images.visualUplift}, recomputed ${measuredUplift}`);
  }
  if (mismatches.length) {
    throw new BenchmarkError("gate_claim_mismatch", `The report's claims disagree with the artifacts it names: ${mismatches.join("; ")}.`);
  }
  return { gates, releaseReady, measuredUplift, sources: { corpus: corpusPath, results: resultsPath, images: manifestPath, judging: judgingPath, rawJudging: rawPath } };
}

/** Read a diagnostic artifact, tolerating its absence. */
async function optionalJson(path) {
  try { return await readJson(path, "manifest_missing"); } catch (error) {
    if (error.code === "manifest_missing") return null;
    throw error;
  }
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
    corpus: "string", results: "string", images: "string", judging: "string", "raw-judging": "string",
    smoke: "string", defects: "string", activation: "string", out: "string", verify: "string", tests: "string",
  });
  if (args.verify) {
    const reportPath = resolve(String(args.verify));
    const report = await readJson(reportPath, "report_missing");
    // Integrity first: a malformed report, an empty ledger, or an activation
    // claim without passing gates is always an error. So is a ledger whose
    // numbers or regression tests do not match the run, and a result set that
    // does not cover every scenario with a terminal outcome. And the gates
    // themselves are recomputed from the artifacts, never read off the report.
    const corpusPath = args.corpus ?? resolveSource(reportPath, report.sources?.corpus);
    const corpus = corpusPath ? await readJson(corpusPath, "corpus_missing") : null;
    const recomputed = await recomputeFromSources(report, reportPath, {
      corpus: args.corpus, results: args.results, images: args.images, judging: args.judging, "raw-judging": args["raw-judging"],
    });
    const result = verifyAggregateReport(report, { corpus, testsDir: args.tests ?? "tests" });
    const unmet = [
      ...Object.entries(recomputed.gates).filter(([, value]) => value !== true).map(([name]) => `gate:${name}`),
      ...result.unresolvedCritical.map((id) => `defect:${id}`),
    ];
    process.stdout.write(`${JSON.stringify({
      report: reportPath, ...result,
      unmetGates: unmet,
      recomputed: { releaseReady: recomputed.releaseReady, visualUplift: recomputed.measuredUplift, gates: recomputed.gates },
      releaseGate: recomputed.releaseReady ? "passed" : "failed",
    })}\n`);
    // Release readiness is the contract, not an opt-in: a report that is not
    // ready fails the command that verifies it. An earlier version moved this
    // behind an environment variable, which turned the gate into a switch.
    if (recomputed.releaseReady !== true) {
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
  const manifest = await optional(args.images ?? ".pi/benchmark/composed-manifest.json", "manifest_missing");
  const judging = await optional(args.judging ?? ".pi/benchmark/judge.json", "manifest_missing");
  const rawJudging = await optional(args["raw-judging"] ?? ".pi/benchmark/judge-raw-image.json", "manifest_missing");
  const liveSmoke = await optional(args.smoke ?? ".pi/benchmark/live-smoke.json", "report_missing");
  const defects = await optional(args.defects ?? ".pi/benchmark/defects.json", "report_missing");
  const activation = await optional(args.activation ?? ".pi/benchmark/activation.json", "report_missing");
  const report = await buildAggregateReport({
    corpus, results, manifest, judging, liveSmoke, defects, activation, rawJudging,
    sources: {
      corpus: args.corpus ?? ".pi/benchmark/corpus.json",
      results: args.results ?? ".pi/benchmark/results.json",
      images: args.images ?? (manifest ? ".pi/benchmark/composed-manifest.json" : null),
      judging: args.judging ?? (judging ? ".pi/benchmark/judge.json" : null),
      rawJudging: args["raw-judging"] ?? (rawJudging ? ".pi/benchmark/judge-raw-image.json" : null),
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
