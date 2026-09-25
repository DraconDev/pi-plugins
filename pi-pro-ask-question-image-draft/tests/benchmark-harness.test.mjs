import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { absoluteScore, blindLabels, compareCorpus, runLocal } from "../scripts/benchmark/compare.mjs";
import { generateCorpus, normalizeCorpus, validateCorpus } from "../scripts/benchmark/corpus.mjs";
import { adjudicate, judgeSummary, parseStrictJudge } from "../scripts/benchmark/judge.mjs";
import { ingestImageManifest } from "../scripts/benchmark/images.mjs";
import { buildAggregateReport, recomputeGates, recomputeComparison, verifyAggregateReport } from "../scripts/benchmark/report.mjs";

function legacyScenario(overrides = {}) {
  return {
    id: "t-1",
    stratum: "ordinary",
    classification: "legacy-single",
    comparisonScope: "local-only",
    inputValid: true,
    canonicalInput: {
      questions: [{
        question: "Pick one",
        header: "Pick",
        options: [
          { key: "a", label: "Alpha", description: "First" },
          { key: "b", label: "Beta", description: "Second" },
        ],
      }],
    },
    expected: { outcome: "completed", oracle: "exact", classification: "answer-captured", answers: [{ questionIndex: 0, kind: "option", answer: "Beta" }] },
    terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: false, maxStages: 4, explicitApproval: true },
    visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
    ...overrides,
  };
}

function stagedScenario(overrides = {}) {
  return {
    id: "t-2",
    stratum: "adversarial",
    classification: "staged",
    comparisonScope: "local-only",
    inputValid: true,
    canonicalInput: {
      reviewId: "t-2",
      title: "staged",
      stages: [{
        id: "s1", kind: "choice", header: "S1", prompt: "Pick several", multiSelect: true,
        options: [
          { key: "x", label: "X-ray", description: "One" },
          { key: "y", label: "Yankee", description: "Two" },
          { key: "z", label: "Zulu", description: "Three" },
        ],
        allowOther: true, allowRevision: true, required: true,
      }],
    },
    expected: {
      outcome: "completed", oracle: "exact", classification: "answer-captured",
      answers: [{ questionIndex: 0, stageId: "s1", kind: "multi", selected: ["Zulu", "X-ray"] }],
    },
    terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: false, maxStages: 6, explicitApproval: true },
    visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
    ...overrides,
  };
}

describe("harness honesty: execution and oracles", () => {
  it("scores a matching legacy answer and fails a mismatched one", async () => {
    const good = await runLocal(legacyScenario());
    assert.equal(absoluteScore(legacyScenario(), good).pass, true);
    // The same execution scored against a different oracle must fail.
    const wrong = legacyScenario({ expected: { outcome: "completed", oracle: "exact", classification: "x", answers: [{ questionIndex: 0, kind: "option", answer: "Alpha" }] } });
    const scored = absoluteScore(wrong, good);
    assert.equal(scored.pass, false);
    assert.match(scored.reason, /answer-mismatch/);
  });

  it("treats a multi-select answer as a set, not a sequence", async () => {
    const scenario = stagedScenario();
    const local = await runLocal(scenario);
    const score = absoluteScore(scenario, local);
    assert.equal(score.pass, true, score.reason);
  });

  it("passes an expected-invalid scenario only on a real pre-UI rejection", async () => {
    const negative = legacyScenario({
      id: "t-neg", stratum: "adversarial", inputValid: false,
      canonicalInput: { questions: "not-a-question-list" },
      expected: { outcome: "invalid", oracle: "exact", classification: "rejected-before-ui", answers: [] },
    });
    const local = await runLocal(negative);
    assert.equal(local.rejectedBeforeUi, true);
    assert.equal(absoluteScore(negative, local).pass, true);
    // A valid input can never satisfy an invalid expectation.
    const impossible = legacyScenario({ expected: { outcome: "invalid", oracle: "exact", classification: "x", answers: [] } });
    const accepted = await runLocal(impossible);
    assert.equal(absoluteScore(impossible, accepted).pass, false);
  });

  it("distinguishes the terminal-only oracle from the exact oracle", async () => {
    const terminalOnly = legacyScenario({ expected: { outcome: "completed", oracle: "terminal-only", classification: "source-terminal-only", answers: [] } });
    const local = await runLocal(terminalOnly);
    assert.equal(absoluteScore(terminalOnly, local).pass, true);
    assert.match(absoluteScore(terminalOnly, local).reason, /terminal-only/);
    // The same case with the exact oracle is a real answer mismatch.
    const exact = legacyScenario({ expected: { outcome: "completed", oracle: "exact", classification: "x", answers: [] } });
    assert.equal(absoluteScore(exact, local).pass, false);
  });

  it("asserts the revision payload, not just the revision status", async () => {
    const revision = stagedScenario({
      id: "t-rev",
      expected: {
        outcome: "revision", oracle: "exact", classification: "source-intent", answers: [],
        revision: { stageId: "s1", stageIndex: 0, feedback: "Tighten the copy", requestedRound: 2 },
      },
    });
    const local = await runLocal(revision);
    assert.equal(local.result.status, "revision");
    assert.equal(absoluteScore(revision, local).pass, true);
    const wrongFeedback = structuredClone(revision);
    wrongFeedback.expected.revision.feedback = "something else";
    assert.equal(absoluteScore(wrongFeedback, local).pass, false);
  });

  it("never invents an answer when the oracle records none", async () => {
    const noAnswer = legacyScenario({ expected: { outcome: "completed", oracle: "terminal-only", classification: "source-terminal-only", answers: [] } });
    const local = await runLocal(noAnswer);
    assert.equal(local.result.status, "completed");
    assert.equal(local.result.answers.length, 1);
  });

  it("keeps deterministic labels seeded per case", () => {
    assert.deepEqual(blindLabels(1, "a"), blindLabels(1, "a"));
    assert.deepEqual(Object.values(blindLabels(7, "case-1")).sort(), ["candidate", "reference"]);
  });
});

describe("harness honesty: corpus gates", () => {
  it("accepts a negative scenario that carries a reserved label on purpose", () => {
    const corpus = generateCorpus({ count: 10, seed: 3 });
    const scenario = corpus.scenarios.find((item) => item.stratum === "adversarial");
    scenario.inputValid = false;
    scenario.comparisonScope = "local-only";
    scenario.expected = { outcome: "invalid", oracle: "exact", classification: "rejected-before-ui", answers: [] };
    scenario.canonicalInput = { questions: [{ question: "Author Other as an option", header: "Bad", options: [{ label: "Other", description: "host owned" }, { label: "Alpha", description: "real" }] }] };
    assert.equal(validateCorpus(corpus), true);
    // The same label in a valid review is still rejected.
    const valid = structuredClone(corpus);
    const other = valid.scenarios.find((item) => item.stratum === "ordinary");
    other.canonicalInput.questions[0].options[0].label = "Type something.";
    assert.throws(() => validateCorpus(valid), /not a valid review|reserved/);
  });

  it("rejects an oracle block without an explicit oracle kind", () => {
    const corpus = generateCorpus({ count: 10, seed: 3 });
    delete corpus.scenarios[0].expected.oracle;
    assert.throws(() => validateCorpus(corpus), /oracle/);
  });

  it("rejects a revision expectation with no payload", () => {
    const corpus = generateCorpus({ count: 10, seed: 3 });
    corpus.scenarios[0].expected.outcome = "revision";
    assert.throws(() => validateCorpus(corpus), /revision/);
  });

  it("round-trips an imported corpus through the same gate", () => {
    const corpus = generateCorpus({ count: 10, seed: 11 });
    assert.deepEqual(normalizeCorpus(JSON.parse(JSON.stringify(corpus))).scenarios, corpus.scenarios);
  });
});

describe("harness honesty: visual judging", () => {
  it("never counts a tie as candidate credit", () => {
    const passes = [{ winner: "tie", severeFailure: "none" }, { winner: "tie", severeFailure: "none" }];
    const result = adjudicate(passes, { A: "candidate", B: "reference" });
    assert.equal(result.candidate, false);
    const summary = judgeSummary([result]);
    assert.equal(summary.candidateWins, 0);
    assert.equal(summary.ties, 1);
  });

  it("marks a disagreement undecided instead of a win", () => {
    const result = adjudicate([{ winner: "A", severeFailure: "none" }, { winner: "B", severeFailure: "none" }], { A: "candidate", B: "reference" });
    assert.equal(result.winner, "undecided");
    assert.equal(result.candidate, false);
  });

  it("credits a candidate only when both passes agree on it", () => {
    const labels = { A: "reference", B: "candidate" };
    const result = adjudicate([{ winner: "B", severeFailure: "none" }, { winner: "B", severeFailure: "none" }], labels);
    assert.equal(result.candidate, true);
  });

  it("rejects judge output that is not strict JSON", () => {
    assert.throws(() => parseStrictJudge("looks good"), /strict JSON/);
    assert.throws(() => parseStrictJudge('{"winner":"C"}'), /required schema/);
  });
});

describe("harness honesty: images and the aggregate report", () => {
  it("reports zero generated images for an empty manifest instead of a fake count", async () => {
    const report = await ingestImageManifest({ schemaVersion: 1, kind: "benchmark-image-manifest", images: [] }, { max: 600 });
    assert.equal(report.generated, 0);
    assert.equal(report.severeFailures, 0);
    assert.equal(report.decisionUtility, null);
  });

  it("recomputes accuracy from the per-case results, not a summary", () => {
    const corpus = generateCorpus({ count: 10, seed: 5 });
    const results = {
      kind: "benchmark-comparison",
      summary: { deterministicAccuracy: 1, wilson95LowerBound: 1 },
      cases: corpus.scenarios.map((scenario, index) => ({ id: scenario.id, pass: index < 7, stableAcrossPasses: true })),
    };
    const comparison = recomputeComparison(corpus, results);
    assert.equal(comparison.deterministicAccuracy, 0.7);
    assert.equal(comparison.failed, 3);
    assert.notEqual(comparison.deterministicAccuracy, results.summary.deterministicAccuracy);
  });

  it("rejects results that do not cover the corpus", () => {
    const corpus = generateCorpus({ count: 10, seed: 5 });
    const results = { kind: "benchmark-comparison", cases: corpus.scenarios.slice(0, 5).map((s) => ({ id: s.id, pass: true })) };
    assert.throws(() => recomputeComparison(corpus, results), /cover/);
  });

  it("derives every gate from recomputed evidence", () => {
    const comparison = { deterministicAccuracy: 1, wilson95LowerBound: 0.99, unstableCases: [] };
    const images = { gates: { visualUplift: false, confidenceBound: false, severeFailures: false, imageBudget: true } };
    const gates = recomputeGates(comparison, images);
    assert.equal(gates.accuracy, true);
    assert.equal(gates.visualUplift, false);
    assert.equal(gates.stability, true);
  });

  it("refuses to claim activation while a gate is unmet", async () => {
    const corpus = generateCorpus({ count: 1000, seed: 20260925 });
    const results = {
      kind: "benchmark-comparison",
      cases: corpus.scenarios.map((scenario) => ({ id: scenario.id, pass: true, stableAcrossPasses: true })),
    };
    const report = await buildAggregateReport({
      corpus,
      results,
      manifest: { images: [], failures: [], planned: 0 },
      judging: { summary: { judgedCases: 0, candidateWins: 0, candidateWinRate: 0, wilson95LowerBound: 0, ties: 0, undecided: 0, severeImageFailureRate: 0 }, skippedCases: 0 },
      liveSmoke: { status: "passed", observedAt: "2026-09-25T10:00:00Z", details: "real tty" },
      defects: [],
    });
    assert.equal(report.releaseReady, false);
    assert.throws(() => verifyAggregateReport({ ...report, activation: { claimed: true, status: "passed", afterGates: true } }), /after every gate/);
    assert.equal(verifyAggregateReport(report).activationClaim, "not-claimed");
  });

  it("will not verify a report whose live smoke never ran", async () => {
    const corpus = generateCorpus({ count: 1000, seed: 20260925 });
    const results = { kind: "benchmark-comparison", cases: corpus.scenarios.map((s) => ({ id: s.id, pass: true, stableAcrossPasses: true })) };
    const report = await buildAggregateReport({
      corpus, results, manifest: { images: [], failures: [], planned: 0 },
      liveSmoke: { status: "not_run" }, defects: [],
    });
    assert.equal(report.releaseReady, false);
    assert.equal(report.gates.liveSmoke, false);
  });
});
