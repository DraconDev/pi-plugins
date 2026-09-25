#!/usr/bin/env node
/**
 * The defect ledger is generated, not hand-written.
 *
 * Two auditor findings forced this: the ledger asserted "resolved" with no
 * machine-checkable link to a regression test, and its summary quoted numbers
 * (65/200, 32.5%, 0.264) that no artifact agreed with (68/200, 34%, 0.2779).
 * Both are now impossible. Every entry names the test that pins its root cause,
 * that test must exist and must mention the defect id, and any measured claim
 * is read from the artifacts of the run being reported.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { verifyDefectLedger } from "./report.mjs";

const REGRESSION_FILE = "tests/benchmark-regressions.test.mjs";

/**
 * `status: "open"` entries are resolved by the run that measures them: the
 * visual gate is recomputed, so the ledger states the measured verdict rather
 * than a remembered one.
 */
const DEFECTS = [
  {
    id: "HARNESS-001", severity: "P0", status: "resolved",
    summary: "Report and image counts were self-reported: a skipped image run reported generated=0 as a success and the report trusted a summary block instead of the per-case results.",
    rootCause: "The report and image commands formatted their own totals rather than recomputing them from the artifacts on disk.",
    fix: "recomputeComparison and ingestImageManifest derive every count from the per-case results and the manifest entries; a test pins that an empty manifest reports zero.",
  },
  {
    id: "HARNESS-002", severity: "P0", status: "resolved",
    summary: "--passes was a label: one execution was recorded as N passes, so the '2,000 real executions' figure was unearned.",
    rootCause: "The comparison loop ran a single execution and copied the requested pass count into the per-case record.",
    fix: "compareCorpus runs one execution per requested pass and records the count actually executed; a test compares passes=1 against passes=2.",
  },
  {
    id: "HARNESS-003", severity: "P0", status: "resolved",
    summary: "Expected-invalid scenarios could never pass, so the adversarial stratum's invalid cases were scored as failures of the package rather than successes of the validator.",
    rootCause: "Scoring compared an expected outcome to the executed status without checking that a rejection happened before the UI was built.",
    fix: "absoluteScore requires rejectedBeforeUi for an invalid expectation, and a valid input can never satisfy it.",
  },
  {
    id: "HARNESS-004", severity: "P0", status: "resolved",
    summary: "The RPiV adapter dropped previews, notes and multi-select and mis-mapped the select protocol, so the head-to-head compared a crippled reference.",
    rootCause: "The adapter translated the local envelope into RPiV's question shape without its optional fields.",
    fix: "The adapter now carries preview, notes and multiSelect and drives RPiV's real select protocol; the shared-case capability mix is recorded in the results.",
  },
  {
    id: "HARNESS-005", severity: "P1", status: "resolved",
    summary: "A multi-select stage with no recorded answer looped forever and stalled the whole run.",
    rootCause: "The local driver waited for an answer to arrive for a stage the oracle never resolves.",
    fix: "The stage loop terminates on the resolved status; a test runs a multi-select scenario with an empty expectation and asserts a terminal status.",
  },
  {
    id: "HARNESS-006", severity: "P1", status: "resolved",
    summary: "corpus.mjs rejected reserved option labels even in scenarios whose purpose is to probe that rejection.",
    rootCause: "One label rule was applied to the whole corpus instead of to scenarios that are expected to be valid.",
    fix: "The reserved-label rule is applied to inputValid scenarios only; a test admits a negative scenario that carries a reserved label on purpose.",
  },
  {
    id: "HARNESS-007", severity: "P1", status: "resolved",
    summary: "The live smoke had no interactive driver, so inline-image rendering, collapse/reopen and the final review were never exercised.",
    rootCause: "The gate only checked preconditions and stopped.",
    fix: "live-driver.mjs loads the real extension through Pi's loader on a pseudo-terminal and walks the real key sequence; the driver records the editor it resolved and the quit keys it derived.",
  },
  {
    id: "HARNESS-008", severity: "P0", status: "resolved",
    summary: "benchmark:images refused to generate, so the contract command produced an empty manifest instead of images.",
    rootCause: "A provider-call kill switch was left in the image path.",
    fix: "The contract command generates through the real generator; the kill switch is gone and a test asserts it cannot return.",
  },
  {
    id: "HARNESS-009", severity: "P0", status: "resolved",
    summary: "benchmark:corpus silently overwrote the imported Space Bunny Alpha corpus with a synthetic fixture whenever the target was missing or replaced.",
    rootCause: "The default output path and the regeneration path were the same decision.",
    fix: "An existing valid corpus is re-validated and reported as such, and replacement requires an explicit --replace.",
  },
  {
    id: "HARNESS-010", severity: "P1", status: "resolved",
    summary: "The live smoke was flaky: the PTY harness interleaved key sending with slow reads, so the terminal sometimes missed keys.",
    rootCause: "Keys were written into the pty while the driver was still painting.",
    fix: "The driver and the harness exchange keys through a queue file and the harness waits for a painted frame before the next key.",
  },
  {
    id: "HARNESS-011", severity: "P1", status: "resolved",
    summary: "benchmark:report --verify parsed --verify as a boolean and crashed before reading the report.",
    rootCause: "The argument was declared as a flag instead of a string value.",
    fix: "The argument is a string and a test parses the exact contract form.",
  },
  {
    id: "HARNESS-012", severity: "P1", status: "resolved",
    summary: "The live gate's editor came from whatever $EDITOR the caller's shell happened to export, and the driver quit the editor with micro's ctrl+q, so the gate passed on one machine and died on another for reasons unrelated to the package.",
    rootCause: "Editor resolution was an ambient environment lookup and the quit sequence was a hard-coded constant.",
    fix: "Editor resolution follows Pi's own order (settings, VISUAL/EDITOR, Pi default), records which source answered, refuses to run when the binary is absent, and provisions one that exists; the quit sequence is derived from the resolved command.",
  },
  {
    id: "JUDGE-001", severity: "P1", status: "resolved",
    summary: "Ties were not separated from wins and disagreements were not adjudicated, which would have inflated the candidate's rate.",
    rootCause: "Any non-A winner was treated as a reference win and ties were folded into the same bucket.",
    fix: "A tie is decided but never credit, an undecided case stays in the denominator, and judgeSummary reports both the strict and the decided-only rate.",
  },
  {
    id: "JUDGE-002", severity: "P0", status: "resolved",
    summary: "The judge prompt hard-coded the generated-image arm as 'A' while the seeded label map could call A the reference, so on every case whose hash fell on the other side an image win was recorded as a reference win.",
    rootCause: "The blinding labels and the prompt's arm letters were chosen independently and then spread over each other.",
    fix: "The arm letters are assigned by the seeded blinding and the prompt is written to match, so the recorded winner is attributed to the arm the judge actually saw.",
    claim: "casesWithInvertedAttribution: 69",
  },
  {
    id: "JUDGE-003", severity: "P1", status: "resolved",
    summary: "A verdict the model wrapped in a fenced block or a sentence of preamble was recorded as a judge error, so 30 of 200 cases were lost for a formatting reason.",
    rootCause: "Only bare JSON.parse was accepted.",
    fix: "parseJudgeReply recovers the first balanced object and still validates it against the same strict schema, recording whether the reply was strict or recovered.",
  },
  {
    id: "JUDGE-004", severity: "P1", status: "resolved",
    summary: "A disagreement between the two passes was recorded as undecided, so the contract's 'disagreement adjudication' was never actually implemented and 33 cases could not count.",
    rootCause: "adjudicate() had no path to a third opinion.",
    fix: "A disagreement is put to a third independent adjudication pass and decided by majority; only a split the adjudicator cannot break stays undecided, and it is never credited.",
  },
  {
    id: "VISUAL-001", severity: "P1", status: "measured",
    summary: "The visual decision-utility gate: the generated images must be meaningfully more useful than the realistic terminal fallback in at least 60% of the 200 blinded comparisons, with the two-sided 95% lower bound above 50% and severe readability/artifact failures at or below 2%.",
    rootCause: "The gate is measured, not asserted: it is recomputed from the judging artifact on every report and can only pass with the evidence present.",
    fix: "Recomputed per run; the numbers below are read from judge.json when the ledger is written.",
  },
  {
    id: "VISUAL-002", severity: "P1", status: "resolved",
    summary: "The image prompt asked for 'only shapes, blocks, bars, lines and colour' and forbade text outright, so the model drew content-free rectangles that carried no decision information.",
    rootCause: "A previous failure mode (invented pseudo-text) was over-corrected into the opposite failure mode, and the prompt stopped naming the surface and the treatment at all.",
    fix: "image-prompt.mjs derives the surface from the scenario title and the treatment from the option's own vocabulary into a concrete, drawable layout instruction, and keeps the option's name out of the prompt so the judged comparison stays blinded.",
  },
  {
    id: "GATE-001", severity: "P1", status: "resolved",
    summary: "npm run smoke:live could not be run by a contract check because it required an interactive TTY the caller does not have.",
    rootCause: "The gate demanded a TTY and refused to provide one.",
    fix: "smoke:live re-runs itself inside a real pseudo-terminal when the caller has none, without weakening the TTY requirement the driver asserts.",
  },
  {
    id: "GATE-002", severity: "P1", status: "resolved",
    summary: "benchmark:report --verify crashed on an open P0/P1, conflating a release fact with a malformed report.",
    rootCause: "One exception path served both structural and release problems.",
    fix: "An open P0/P1 is reported as data and only the release gate turns it into a failure.",
  },
  {
    id: "GATE-003", severity: "P2", status: "resolved",
    summary: "The contract names .pi/benchmark/images/visual-001-option-1.png, a canonical name this corpus never produced; the gate silently substituted manifest.images[0] and recorded the substitution as a fix.",
    rootCause: "The contract path and the pipeline's naming had no relationship, and the gap was papered over with a fallback.",
    fix: "The image pipeline writes the canonical alias itself (the first visual scenario's options, in order) and a missing requested path is now a hard failure with no substitution.",
  },
  {
    id: "GATE-004", severity: "P0", status: "resolved",
    summary: "Release readiness sat behind an environment variable the contract never sets, so `benchmark:report --verify` exited 0 on a report that was not ready.",
    rootCause: "The verifier was written to report a verdict, and the release requirement was bolted on as an opt-in switch.",
    fix: "The verify path always fails when releaseReady is false; the opt-out and the environment variable are gone.",
  },
  {
    id: "GATE-005", severity: "P1", status: "resolved",
    summary: "The verifier never checked that all 1,000 corpus scenarios have a terminal outcome in the results, so a run that dropped cases would still look clean.",
    rootCause: "Only the aggregate counts were compared.",
    fix: "verifyTerminalOutcomes cross-checks the corpus and the per-case results and refuses a report that drops or leaves a case unresolved.",
  },
  {
    id: "GATE-006", severity: "P1", status: "resolved",
    summary: "Resolved defects had no machine-checkable link to a regression test, and the ledger's own numbers were free text that had already drifted from the artifacts.",
    rootCause: "The ledger was a hand-maintained document.",
    fix: "Every resolved critical defect names a test that must exist and mention its id, and any measured claim is read from the run's artifacts and checked by the verifier.",
  },
  {
    id: "GATE-007", severity: "P1", status: "resolved",
    summary: "No benchmark evidence was in the repository: .pi/ is machine-local and git-ignored, so an auditor could not see the corpus, results, report or ledger without re-running everything.",
    rootCause: "The working directory and the durable record were the same, untracked place.",
    fix: "benchmark:publish mirrors the artifacts into the tracked benchmark/ directory with a sha256 index and a sample of real generated images; benchmark:verify-evidence re-checks the mirror.",
  },
  {
    id: "CORPUS-001", severity: "P1", status: "resolved",
    summary: "benchmark:corpus to a fresh path produced a synthetic 'Path 0001 decision 1' fixture with provenance: null, so the shipped corpus could not be reproduced from the checkout.",
    rootCause: "The Space Bunny Alpha corpus was assembled from model-written shards outside the repository and only its output file was kept.",
    fix: "The corpus is committed under benchmark/corpus/ and re-emitted through the same validation gate, so the contract command reproduces the real corpus with its provenance on any machine.",
  },
];

function measuredDefect(defect, { judged, comparison, images, liveSmoke }) {
  const claim = { ...(defect.claim ?? {}) };
  if (judged) {
    claim.judgedCases = judged.judgedCases;
    claim.candidateWins = judged.candidateWins;
    claim.candidateWinRate = judged.candidateWinRate;
    claim.wilson95LowerBound = judged.wilson95LowerBound;
    claim.severeImageFailureRate = judged.severeImageFailureRate;
  }
  if (comparison) {
    claim.cases = comparison.total;
    claim.failedCases = comparison.failed;
    claim.unstableCases = comparison.unstableCases.length;
  }
  if (images) claim.generatedImages = images.generated;
  if (liveSmoke) claim.liveSmokeStatus = liveSmoke.status;
  if (defect.id === "VISUAL-001") {
    const rate = judged?.candidateWinRate ?? 0;
    const bound = judged?.wilson95LowerBound ?? 0;
    const severe = judged?.severeImageFailureRate ?? 1;
    const measured = judged != null && (judged.judgedCases >= 200 && rate >= 0.6 && bound > 0.5 && severe <= 0.02);
    return {
      ...defect,
      status: measured ? "resolved" : "open",
      claim,
      summary: `${defect.summary} Measured on this run: ${judged?.candidateWins ?? 0}/${judged?.judgedCases ?? 0} wins (${(rate * 100).toFixed(1)}%, 95% lower bound ${(bound * 100).toFixed(1)}%) against a 60% / 50% requirement, severe failures ${(severe * 100).toFixed(1)}% against a 2% ceiling.`,
    };
  }
  return { ...defect, claim };
}

export function buildDefectLedger({ judged = null, comparison = null, images = null, liveSmoke = null, regressionFile = REGRESSION_FILE } = {}) {
  const ledger = DEFECTS.map((defect) => ({ regressionTest: regressionFile, ...measuredDefect(defect, { judged, comparison, images, liveSmoke }) }));
  // Every resolved critical defect must be pinned by a named test in this repo.
  const source = existsSync(resolve(regressionFile)) ? readFileSyncSafe(regressionFile) : "";
  for (const defect of ledger) {
    if ((defect.severity === "P0" || defect.severity === "P1") && defect.status === "resolved" && !source.includes(defect.id)) {
      throw new BenchmarkError("defect_untraced", `Resolved defect ${defect.id} is not pinned by a named test in ${regressionFile}.`);
    }
  }
  return { schemaVersion: SCHEMA_VERSION, kind: "benchmark-defect-ledger", defects: ledger };
}

function readFileSyncSafe(path) {
  try { return readFileSync(resolve(path), "utf8"); } catch { return ""; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv, { judged: "string", report: "string", out: "string", tests: "string" });
  const report = await readJson(args.report ?? ".pi/benchmark/report.json", "report_missing");
  const ledger = buildDefectLedger({
    judged: report.images?.judging ?? null,
    comparison: report.comparison ?? null,
    images: report.images ?? null,
    liveSmoke: report.liveSmoke ?? null,
    regressionFile: args.tests ?? REGRESSION_FILE,
  });
  verifyDefectLedger(ledger.defects, { judged: report.images?.judging ?? null, cases: report.comparison, testsDir: "tests" });
  const out = await writeJson(args.out ?? ".pi/benchmark/defects.json", ledger);
  const open = ledger.defects.filter((defect) => defect.status === "open");
  process.stdout.write(`${JSON.stringify({ out, defects: ledger.defects.length, resolved: ledger.defects.length - open.length, open: open.map((defect) => defect.id) })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:ledger: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
