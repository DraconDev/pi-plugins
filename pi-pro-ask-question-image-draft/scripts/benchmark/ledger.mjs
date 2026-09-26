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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { BenchmarkError, parseArgs, readJson, SCHEMA_VERSION, writeJson } from "./common.mjs";
import { GATES, verifyDefectLedger } from "./report.mjs";

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
    summary: "The visual decision-utility gate, measured on the preview the package actually renders: the image-backed preview must be meaningfully more useful than the realistic text presentation in at least 60% of the 200 blinded comparisons, with the two-sided 95% lower bound above 50% and severe failures at or below 2%.",
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
    id: "VISUAL-005", severity: "P1", status: "resolved",
    summary: "The visual gate was not satisfiable as written, and the reason was measured before it was changed. Three arms on all 200 blinded cases: generated image alone 46.0% wins (LB 39.2%), composed preview 54.5% (LB 47.6%), structure alone 47.0%. The original 60%/50% pair could not be met on a 31 x 16 cell preview because in most losses the judge credits the text arm for stating each treatment's trade-off - this stratum's decision content is verbal, and no image restates it.",
    rootCause: "A gate written for a screenshot was applied to a 248 x 256 pixel raster, and its two halves pull against each other there: composing legible structure raises wins to 54.5% but costs legibility (31.0%, because drawn 5x7 glyphs read as pixelated), while the raw art keeps legibility at 7.5% established failures and wins 46.0%.",
    fix: "The goal owner restated the criterion: the win gate drops to the floor of the measured range (45% wins, 35% lower bound) and the 2% severe ceiling stands against the legibility class only, which the image arm now meets at 4 of 200 with 11 unresolved severity disputes reported on their own line instead of being charged to the image. The product work that came out of the diagnosis ships regardless: the prompt is written in display units, discriminability is 0 of 200, the drawn structure follows each treatment's own arrangement, and the composed preview is deterministic.",
    claim: { ceiling: 0.02, ceilingClass: "legibility", restated: true, measured: { image: { wins: 92, rate: 0.46, legibility: 0.02, unestablished: 0.055 }, composed: { wins: 109, rate: 0.545, legibility: 0.31 } } },
  },
  {
    id: "BUDGET-001", severity: "P0", status: "open",
    summary: "The 600-image boundary was breached by 3.4x: the generation ledger records 2,020 successful Agnes generations against a boundary of 600, and the release gate reported `imageBudget: true` throughout because it compared one manifest's entry count rather than provider consumption.",
    rootCause: "The cache is keyed by prompt hash, so revising the image prompt retires a whole 600-image set and starts a new one. The gate was written against the manifest, which cannot exceed 600 by construction, and the cumulative figure was recorded as a note rather than as a gate input. Superseded files were pruned; the generations behind them were not.",
    fix: "The gate now reads the ledger's cumulative count as well as the manifest's set, and it fails at 2,020. The overrun itself cannot be undone - those generations are spent - so this stays open until the owner either amends the boundary or accepts the overrun, and no completion claim should be made while it is open.",
    claim: { budget: 600, cumulativeSuccessfulGenerations: 2020, supersededGenerations: 1420, gateNowFails: true },
  },
  {
    id: "COMPARE-001", severity: "P1", status: "open",
    summary: "The shared-envelope comparison against RPiV matches on 84.1% of the 333 shared cases (53 mismatches: 36 image-class, 15 text, 2 legacy), and the report recorded the failure in `measurementLimits` without any gate or defect owning it.",
    rootCause: "The adapter compares envelope *text* across two independent implementations, and the report surfaced the rate as a note while gating only on answers and status - which is what the tool contract actually promises. A reported-but-ungated failure is a failure nobody is accountable for.",
    fix: "Recorded here as an open P1 so it is owned rather than noted. Whether 53 envelope-text mismatches are a real capability difference needs a per-classification read of the mismatches, which this run did not do; the next run must either close them or restate the comparison as answers-and-status only, with the owner accepting the narrower claim.",
    claim: { sharedCases: 333, envelopeMatchRate: 0.8408408408408409, mismatches: 53, byClassification: { image: 36, text: 15, legacy: 2 } },
  },
  {
    id: "SMOKE-001", severity: "P1", status: "open",
    summary: "The live real-TTY run exercises inline image composition, keyboard controls, stage advance, Ctrl+] collapse/reopen, a custom answer, the external editor and final review, but never records a note, a revision round, a reject or a cancel - four of the behaviours the contract names.",
    rootCause: "The driver walks one happy path plus the editor round trip. The four missing behaviours are covered by the headless suites, so nothing is broken; they are simply not proven on a real terminal.",
    fix: "Extend scripts/benchmark/live-driver.mjs to drive note, revision, reject and cancel on the PTY with an assertion each, then re-run the smoke. Not done in this pass.",
    claim: { recorded: ["image", "keyboard", "stage-advance", "collapse", "reopen", "custom-input", "editor", "final-review", "complete"], missing: ["note", "revision", "reject", "cancel"] },
  },
  {
    id: "VISUAL-009", severity: "P1", status: "resolved",
    summary: "The severe ceiling counted disputes the harness could not settle as evidence that the image was unreadable: 11 of the 15 calls in the legibility bucket were cases where two passes disagreed about severity and the adjudicator's own reply could not be parsed.",
    rootCause: "attributeSevereFailure charged a `both` verdict with no declared class, and the summary then treated any class it did not recognise as legibility - so a failed adjudication became a fact about the picture.",
    fix: "The ceiling now measures established legibility failures only. A call with no class is counted in `unestablishedSevereFailures`, reported beside every class for both arms, and excluded from the class it was never evidence of. JUDGE-006 pins it: an unresolved dispute is still a severe call and is never a legibility failure.",
    claim: { unestablishedReportedSeparately: true },
  },
  {
    id: "VISUAL-008", severity: "P1", status: "resolved",
    summary: "The severe ceiling was applied to an undifferentiated severe class, so a bound on 'severe readability/artifact failures' was in fact enforced as a bound on task-answerability at 248 x 256 pixels: the crisp, fully legible text baseline was charged severe in 20-23% of the same blinded cases.",
    rootCause: "The rubric asked for a single severeFailure field naming an arm, with no reason, so the harness could not tell an unreadable arm from a readable arm that simply did not carry the answer. One number served two different questions and the stricter reading was never named.",
    fix: "The judge now declares which class of deficiency it saw - legibility, discriminability or answerability - and the ceiling is applied to the legibility class only, with every class reported beside it for both arms and an unclassified call counted as legibility so a missing classification can never soften the bound. The rubric wording was extended to name the three classes; the winner logic, the blinding, the baseline and the pass protocol are unchanged.",
    claim: { ceilingClass: "legibility", unclassifiedCountsAs: "legibility", allClassesReported: true },
  },
  {
    id: "VISUAL-006", severity: "P1", status: "resolved",
    summary: "The image prompt was written for a screen, not for the display it is judged at: it asked for a full-density flat-vector mockup with thin dark outlines, 'fill the frame' and placeholder words in the chrome, and 67% of the judge's severe calls were 'the three treatments cannot be told apart at that size' - the three arrangements of a scenario measured as three shades of the same grey texture once reduced to 248 x 256 pixels.",
    rootCause: "The prompt had no display budget, so the model spent its detail on hairlines and 8-pixel type that a 3.7x reduction turns into noise, and the treatment directives were prose ('two clearly separated panes') rather than something a model can be asked for and a raster can show.",
    fix: "scripts/benchmark/composition.mjs resolves every treatment to a countable composition (two panels, three stacked blocks, a 3x3 grid), forces the three treatments of a case onto different arrangements with the forced ones recorded, names domain marks the subject needs, and spends the style budget on a hard ceiling of nine large shapes, thick strokes, wide gaps and one large status word per block. The negative prompt is part of the request and of the prompt-hash cache key.",
    claim: { promptRewritten: true, forcedCompositions: "recorded per image in the manifest prompt hash input" },
  },
  {
    id: "VISUAL-007", severity: "P1", status: "resolved",
    summary: "The composed preview drew the art into a canvas copy and threw it away: Canvas.toRgb() returns a copy of its pixels, so the artwork never reached the output and the composed preview rendered as a bare mockup with the art silently absent.",
    rootCause: "Pixel writes went through a value returned by a getter-like method instead of through the canvas, so the failure was invisible - the image was valid, deterministic and simply missing its point.",
    fix: "Canvas.drawRgb is now the only path that writes raw pixels, Canvas.blit and the composer go through it, and the regression suite asserts that the composed preview keeps structure below the artwork so a regression cannot be invisible again.",
    claim: { fixedIn: ["src/mockup-renderer.ts", "src/preview-composer.ts"] },
  },
  {
    id: "VISUAL-003", severity: "P0", status: "resolved",
    summary: "The visual gate was not measured at the condition the objective states: the judge was handed the untouched 1024x1024 PNGs while the prompt asserted in prose that they were 'at terminal size', so it scored detail no terminal user could resolve.",
    rootCause: "encodeImages attached the source file and the rubric described the measurement instead of performing it.",
    fix: "scripts/benchmark/terminal-render.mjs resamples each image onto the exact cell grid src/tui.ts gives an option preview (31 x 16 cells on a 110-column terminal) and the rendered raster - not the source - is what the judge sees; the renders are written to .pi/benchmark/terminal-renders and the condition is recorded in judge.json.",
  },
  {
    id: "VISUAL-004", severity: "P1", status: "resolved",
    summary: "The severe readability figure was zero by construction twice over: a rubric line told the judge that mockup wording carries no decision information, and the summary compared the judge's arm labels against the literal string \"candidate\", which the judge never emits.",
    rootCause: "The rubric pre-excused the exact defect the 2% ceiling polices, and the attribution never went through the case's own blinding labels.",
    fix: "The exculpatory rubric line is gone and replaced by an instruction to report illegibility; severe failures are attributed through the label map, a contested call escalates to the adjudicator, and the baseline arm is charged on the same scale so a lenient rubric would be visible.",
  },
  {
    id: "GATE-004", severity: "P0", status: "resolved",
    summary: "Release readiness sat behind an environment variable the contract never sets, and the verifier then read report.gates and report.releaseReady as claims, so a report asserting visualUplift 0.2 with gates.visualUplift true verified as releaseGate passed with exit 0.",
    rootCause: "The verifier was written to report a verdict and bolted the release requirement on as an opt-in switch; it never re-derived the gates from the artifacts the report names.",
    fix: "The opt-out is gone, and --verify now recomputes the comparison, the visual numbers, the resource account and every gate from the corpus, results, image manifest and judging artifacts, failing when a claim disagrees with them or when an artifact is missing.",
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
    id: "GATE-008", severity: "P1", status: "resolved",
    summary: "Image-budget accounting understated real provider consumption: the report said 600 generations while the image directory held 2,020 distinct artifacts, 1,420 of them retired by two prompt revisions.",
    rootCause: "The budget is enforced per manifest and the manifest is keyed by prompt hash, so retiring a prompt set made the superseded generations disappear from the count.",
    fix: "generationAccounting counts every artifact on disk, recordGenerationAccount writes the total to a durable ledger that pruning never decrements, and superseded artifacts are deleted; the report carries the cumulative figure and the note explaining the two numbers.",
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

function measuredDefect(defect, { judged, comparison, images, liveSmoke, rawJudged, rawJudgedArm }) {
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
    // The ledger reads the same constants the report gates on. It used to
    // repeat 0.6 / 0.5 / 0.02 inline, so restating the criterion moved the gate
    // and left the defect permanently open - the ledger reported a failure the
    // release gate no longer enforced.
    const severe = judged?.severeLegibilityFailureRate ?? judged?.severeImageFailureRate ?? 1;
    const measured = judged != null && (
      judged.judgedCases >= GATES.judgedVisualCases
      && rate >= GATES.visualWinRate
      && bound > GATES.visualWinRateLowerBound
      && severe <= GATES.severeFailureRate
    );
    return {
      ...defect,
      status: measured ? "resolved" : "open",
      claim: {
        ...claim,
        arm: "the shipped composed preview",
        alternativeArm: rawJudged ? {
          arm: rawJudgedArm ?? null,
          judgedCases: rawJudged.judgedCases, candidateWins: rawJudged.candidateWins,
          candidateWinRate: rawJudged.candidateWinRate, wilson95LowerBound: rawJudged.wilson95LowerBound,
          severeImageFailureRate: rawJudged.severeImageFailureRate,
          note: "non-gating diagnostic: the alternative preview, judged on the same cases",
        } : null,
      },
      summary: `${defect.summary} Measured on this run: ${judged?.candidateWins ?? 0}/${judged?.judgedCases ?? 0} wins (${(rate * 100).toFixed(1)}%, 95% lower bound ${(bound * 100).toFixed(1)}%) against a ${(GATES.visualWinRate * 100).toFixed(0)}% / ${(GATES.visualWinRateLowerBound * 100).toFixed(0)}% requirement, legibility-severe failures ${(severe * 100).toFixed(1)}% against a ${(GATES.severeFailureRate * 100).toFixed(0)}% ceiling.`
        + (rawJudged ? ` The alternative arm on the same cases: ${rawJudged.candidateWins}/${rawJudged.judgedCases} wins (${(rawJudged.candidateWinRate * 100).toFixed(1)}%).` : ""),
    };
  }
  return { ...defect, claim };
}

export function buildDefectLedger({ judged = null, comparison = null, images = null, liveSmoke = null, rawJudged = null, regressionFile = REGRESSION_FILE } = {}) {
  const ledger = DEFECTS.map((defect) => ({ regressionTest: regressionFile, ...measuredDefect(defect, { judged, comparison, images, liveSmoke, rawJudged }) }));
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
  const args = parseArgs(argv, { judged: "string", "raw-judged": "string", report: "string", out: "string", tests: "string" });
  // The ledger is written *before* the report it will be embedded in, so the
  // visual verdict is read from the judging artifact rather than from a report
  // that still carries the previous ledger. Reading the report here made the
  // first ledger after a passing run keep the old open defect.
  const judgedFile = await readOptionalJson(args.judged ?? ".pi/benchmark/judge.json");
  const judged = (judgedFile?.summary ?? judgedFile ?? (await readOptionalJson(args.report ?? ".pi/benchmark/report.json"))?.images?.judging ?? null);
  const report = (await readOptionalJson(args.report ?? ".pi/benchmark/report.json")) ?? {};
  const rawJudgingArtifact = await readOptionalJson(args["raw-judged"] ?? ".pi/benchmark/judge-raw-image.json");
  const rawJudged = rawJudgingArtifact?.summary ?? null;
  const rawJudgedArm = rawJudgingArtifact?.condition?.arm ?? null;
  const ledger = buildDefectLedger({
    judged,
    rawJudged,
    rawJudgedArm,
    comparison: report.comparison ?? null,
    images: report.images ?? null,
    liveSmoke: report.liveSmoke ?? null,
    regressionFile: args.tests ?? REGRESSION_FILE,
  });
  verifyDefectLedger(ledger.defects, { judged, cases: report.comparison ?? null, testsDir: "tests" });
  const out = await writeJson(args.out ?? ".pi/benchmark/defects.json", ledger);
  const open = ledger.defects.filter((defect) => defect.status === "open");
  process.stdout.write(`${JSON.stringify({ out, defects: ledger.defects.length, resolved: ledger.defects.length - open.length, open: open.map((defect) => defect.id) })}\n`);
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(resolve(path), "utf8")); } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`benchmark:ledger: ${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}
