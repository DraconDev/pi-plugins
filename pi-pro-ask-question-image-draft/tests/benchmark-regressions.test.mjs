/**
 * Regression suite for the benchmark defect ledger.
 *
 * Every test here is named after the defect id it pins, so the ledger's
 * `regressionTest` reference is mechanically checkable: a resolved critical
 * defect whose id appears in no test name is a defect nobody proved fixed.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { blindLabels, classifyEnvelopeDifference, compareCorpus, runLocal } from "../scripts/benchmark/compare.mjs";
import { aggregateSessionEvidence, BEHAVIOUR_SESSIONS, HAPPY_SESSION, NOTE_TEXT, REVISION_FEEDBACK, SESSION_MODES, sessionPlan, verifySessionEvidence } from "../scripts/benchmark/live-sessions.mjs";
import { DURABLE_CORPUS_PATH, generateCorpus, loadDurableCorpus, validateCorpus } from "../scripts/benchmark/corpus.mjs";
import { editorCandidates, quitSequenceFor, resolveEditorCommand, whichExecutable } from "../scripts/benchmark/editor.mjs";
import { optionPrompt, surfaceSubject, treatmentDirective } from "../scripts/benchmark/image-prompt.mjs";
import { adjudicate, buildCase, judgeSummary, parseJudgeReply } from "../scripts/benchmark/judge.mjs";
import { CONTRACT_ALIAS_PREFIX, ingestImageManifest, optionPrompt as imageOptionPrompt, planImages, promptHash } from "../scripts/benchmark/images.mjs";
import { buildAggregateReport, verifyAggregateReport, verifyDefectLedger, verifyTerminalOutcomes } from "../scripts/benchmark/report.mjs";
import { resolveSmokeImage } from "../scripts/benchmark/smoke-live.mjs";
import { verifyEvidence } from "../scripts/benchmark/publish.mjs";
import { compositionsFor } from "../scripts/benchmark/composition.mjs";
import { renderMockup } from "../src/mockup-renderer.ts";
import { composePreview } from "../src/preview-composer.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { detectImage } from "../scripts/benchmark/images.mjs";

/**
 * Visual scenarios for the prompt invariants.
 *
 * Read from the durable corpus so the invariants are checked against the
 * scenarios that are actually shipped rather than a freshly generated sample,
 * but skipped loudly if that corpus is absent: a test that silently passes on
 * zero scenarios proves nothing.
 */
async function corpusVisualScenarios(limit) {
  const corpus = await loadDurableCorpus({ count: 1000, seed: 20260925 });
  assert.ok(corpus, `${DURABLE_CORPUS_PATH} must be present to check the shipped prompts`);
  return corpus.scenarios.filter((scenario) => scenario.stratum === "visual").slice(0, limit);
}

const ORDINARY_SCENARIO = {
  id: "t-1", stratum: "ordinary", classification: "legacy-single", comparisonScope: "local-only", inputValid: true,
  canonicalInput: { questions: [{ question: "Pick one", header: "Pick", options: [{ key: "a", label: "Alpha", description: "First" }, { key: "b", label: "Beta", description: "Second" }] }] },
  expected: { outcome: "completed", oracle: "exact", classification: "answer-captured", answers: [{ questionIndex: 0, kind: "option", answer: "Beta" }] },
  terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: false, maxStages: 4, explicitApproval: true },
  visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
};

const VISUAL_SCENARIO = {
  id: "v-1", stratum: "visual", classification: "visual-draft", comparisonScope: "local-only", inputValid: true,
      visualPrompt: { required: true, prompt: "Choose how the error notice is shown.", comparisonRubric: [] },
      canonicalInput: {
        reviewId: "v-1", title: "Recovery Banner",
        stages: [{
          id: "s1", kind: "draft", header: "S1", prompt: "How should the error be shown?",
          options: [
            { key: "a", label: "Error recovery Inline", description: "An inline notice stays beside the field." },
            { key: "b", label: "Error recovery Toast", description: "A toast is noticeable but disappears." },
            { key: "c", label: "Error recovery Dialog", description: "A modal interrupts the task." },
          ],
          allowOther: true, allowRevision: true, required: true,
        }],
      },
  expected: { outcome: "completed", oracle: "terminal-only", classification: "source-terminal-only", answers: [] },
  terminalConstraints: { requiresRealTTY: true, requiresConfiguredEditor: false, maxStages: 6, explicitApproval: true },
};

/** A small schema-valid corpus with one real visual scenario in it. */
function smallCorpus(count = 5) {
  const corpus = generateCorpus({ count, seed: 7 });
  const scenarios = corpus.scenarios.map((scenario) => (scenario.stratum === "visual" ? { ...VISUAL_SCENARIO } : scenario));
  return { ...corpus, scenarios };
}

function manifestFor(_corpus, { id = "v-1", keys = ["a", "b", "c"] } = {}) {
  const images = keys.map((key, index) => {
    const prompt = `prompt ${id} ${key}`;
    return {
      id: `${id}:${key}`, optionIds: [`${id}:${key}`], scenarioId: id, stratum: "visual",
      prompt, hash: promptHash(prompt), path: `tests/fixtures/existing-image-${(index % 2) + 1}.png`,
      provider: "agnes", model: "agnes-image-2.5-flash", mimeType: "image/png", width: 1, height: 1, byteCount: 1,
    };
  });
  return { schemaVersion: 1, kind: "benchmark-image-manifest", provider: "agnes", planned: images.length, images, failures: [] };
}

describe("ledger: judging defects", () => {
  it("JUDGE-002: the judged arm letters follow the seeded blinding, so a candidate win is never recorded as a reference win", async () => {
    for (const id of ["v-1", "v-2", "v-3", "v-4"]) {
      const scenario = { ...VISUAL_SCENARIO, id };
      const item = await buildCase(scenario, manifestFor(smallCorpus(), { id }), { seed: 7 });
      const labels = blindLabels(7, id);
      // The prompt must describe the image arm with the letter the label map
      // calls the candidate; a hard-coded "A" inverted half of all cases.
      assert.match(item.prompt, new RegExp(`Arm ${item.imageSide}: the three treatments as images`));
      assert.equal(labels[item.imageSide], "candidate");
      const other = item.imageSide === "A" ? "B" : "A";
      assert.match(item.prompt, new RegExp(`Arm ${other}: the same three treatments as the text a terminal user sees today`));
    }
  });

  it("JUDGE-002: adjudication credits the candidate exactly when the seeded label map says so", () => {
    const labels = { A: "reference", B: "candidate" };
    const pass = (winner) => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure: "none", severeKind: "none", rationale: "r" });
    assert.equal(adjudicate([pass("B"), pass("B")], labels).candidate, true);
    assert.equal(adjudicate([pass("A"), pass("A")], labels).candidate, false);
    // Inverted case: the image arm is B and both passes picked it.
    assert.equal(adjudicate([pass("B"), pass("B")], { A: "candidate", B: "reference" }).candidate, false);
  });

  it("JUDGE-003: a verdict wrapped in prose or a fenced block is recovered, and a reply that is not a verdict still fails", () => {
    const verdict = { winner: "A", utilityA: 0.8, utilityB: 0.2, severeFailure: "none", severeKind: "none", rationale: "clearer" };
    const json = JSON.stringify(verdict);
    assert.equal(parseJudgeReply(json).mode, "strict");
    assert.equal(parseJudgeReply(`Here is my answer:\n\`\`\`json\n${json}\n\`\`\``).mode, "recovered");
    assert.equal(parseJudgeReply(`prose { "nested": {"winner": "B"} } tail ${json}`).verdict.winner, "A");
    assert.throws(() => parseJudgeReply("looks good"), /strict JSON/);
    assert.throws(() => parseJudgeReply('{"winner":"C"}'), /strict JSON/);
    // The schema is not relaxed: a recovered object must still be a verdict.
    assert.throws(() => parseJudgeReply('```json\n{"winner":"A","utilityA":"high"}\n```'), /strict JSON/);
  });

  it("JUDGE-004: a disagreement is adjudicated by a third independent pass and a split stays undecided", () => {
    const pass = (winner) => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure: "none", severeKind: "none", rationale: "r" });
    const labels = { A: "candidate", B: "reference" };
    const resolved = adjudicate([pass("A"), pass("B")], labels, pass("A"));
    assert.equal(resolved.winner, "A");
    assert.equal(resolved.method, "adjudicated");
    assert.equal(resolved.candidate, true);
    const split = adjudicate([pass("A"), pass("B")], labels, pass("tie"));
    assert.equal(split.winner, "undecided");
    assert.equal(split.candidate, false);
    const noAdjudicator = adjudicate([pass("A"), pass("B")], labels);
    assert.equal(noAdjudicator.winner, "undecided");
  });

  it("JUDGE-001: ties and undecided cases are never candidate credit, and they stay in the denominator", () => {
    const results = [
      { winner: "A", candidate: true },
      { winner: "A", candidate: true },
      { winner: "B", candidate: false },
      { winner: "tie", candidate: false },
      { winner: "undecided", candidate: false, method: "judge_error" },
    ];
    const summary = judgeSummary(results);
    assert.equal(summary.candidateWins, 2);
    assert.equal(summary.judgedCases, 5);
    assert.equal(summary.candidateWinRate, 2 / 5);
    // A tie is decided but is not credit; an undecided case is not decided.
    assert.equal(summary.decidedCases, 4);
    assert.equal(summary.decidedWinRate, 2 / 4);
    assert.equal(summary.judgeErrors, 1);
    assert.ok(summary.wilson95LowerBound < summary.candidateWinRate);
  });
});

describe("ledger: visual decision-utility defects", () => {
  it("VISUAL-002: the image prompt names a drawable surface and the treatment, and never leaks the option label", () => {
    const scenario = VISUAL_SCENARIO;
    for (const option of scenario.canonicalInput.stages[0].options) {
      const prompt = imageOptionPrompt(scenario, option);
      // The drawable instruction is now the countable composition (VISUAL-006);
      // this test keeps the two properties that have always mattered: the prompt
      // names what to draw, and it is long enough to carry the instruction.
      assert.match(prompt, /Draw exactly this composition/);
      assert.ok(prompt.length > 200, "a prompt must carry a drawable instruction");
      // The judged comparison is blinded: a caption naming the option would
      // hand the judge the treatment identity.
      assert.equal(prompt.includes(option.label), false, `prompt leaks the option label: ${option.label}`);
    }
  });

  it("VISUAL-002: every corpus treatment resolves to a concrete layout directive, not a bare name", () => {
    const corpus = generateCorpus({ count: 30, seed: 7 });
    for (const scenario of corpus.scenarios) {
      for (const stage of scenario.canonicalInput.stages ?? []) {
        for (const option of stage.options) {
          const { directive, source } = treatmentDirective(option);
          assert.ok(directive.length > 12, `empty directive for ${option.label}`);
          assert.match(source, /^(table|description|derived|default)/);
        }
      }
    }
    assert.equal(surfaceSubject({ canonicalInput: { title: "Team Utilization Heatmap" } }).subject, "a grid heatmap");
    assert.match(surfaceSubject({ canonicalInput: { title: "Recovery Banner" } }).subject, /notification pattern/);
  });

  it("VISUAL-001: the visual gate is computed from judged cases and is never satisfied by ties or misses", async () => {
    const judged = (wins) => ({ summary: { judgedCases: 200, decidedCases: 200, candidateWins: wins, candidateWinRate: wins / 200, wilson95LowerBound: (wins / 200) - 0.05, ties: 0, undecided: 0, judgeErrors: 0, severeImageFailures: 0, severeImageFailureRate: 0 } });
    const SMALL = smallCorpus();
    const manifest = manifestFor(SMALL);
    const report = await buildAggregateReport({
      corpus: SMALL,
      results: { kind: "benchmark-comparison", cases: SMALL.scenarios.map((scenario) => ({ id: scenario.id, pass: true })) },
      manifest, judging: judged(68), liveSmoke: { status: "passed", observedAt: new Date().toISOString(), details: "x" },
      defects: [],
    });
    assert.equal(report.gates.visualUplift, false);
    assert.equal(report.releaseReady, false);
    const good = await buildAggregateReport({
      corpus: SMALL,
      results: { kind: "benchmark-comparison", cases: SMALL.scenarios.map((scenario) => ({ id: scenario.id, pass: true })) },
      manifest, judging: judged(130), liveSmoke: { status: "passed", observedAt: new Date().toISOString(), details: "x" },
      defects: [],
    });
    assert.equal(good.gates.visualUplift, true);
  });

  it("GATE-003: a contract-named image path renders exactly that file, and a missing one is a hard failure", async () => {
    const alias = await resolveSmokeImage(`.pi/benchmark/images/${CONTRACT_ALIAS_PREFIX}1.png`);
    assert.equal(alias.substituted, false);
    assert.equal(alias.path.endsWith(`${CONTRACT_ALIAS_PREFIX}1.png`), true);
    // Nothing is substituted when the named file is absent, inside the image
    // directory or anywhere else.
    await assert.rejects(
      () => resolveSmokeImage(".pi/benchmark/images/visual-001-option-404.png"),
      (error) => error.code === "image_missing",
    );
    await assert.rejects(() => resolveSmokeImage("/nowhere/else.png"), (error) => error.code === "image_missing");
  });

  it("GATE-003: the contract alias names are derived from the first visual scenario, not hard-coded", () => {
    assert.equal(CONTRACT_ALIAS_PREFIX, "visual-001-option-");
  });
});

describe("ledger: live-gate defects", () => {
  it("HARNESS-012: the editor is resolved in Pi's own order and the source is reported", () => {
    assert.deepEqual(editorCandidates({ settingsEditor: "micro", visual: "vi", editor: "ed" }).map((item) => item.source), ["settings.externalEditor", "VISUAL", "EDITOR", "pi-default"]);
    const resolved = resolveEditorCommand({ settingsEditor: "", visual: "", editor: "", env: { PATH: "/usr/bin:/bin" }, platform: "linux" });
    assert.equal(resolved.source, "pi-default");
    assert.equal(resolved.command, "nano");
    assert.equal(resolved.runnable, false, "a missing binary is never reported as runnable");
    const configured = resolveEditorCommand({ settingsEditor: "", visual: "", editor: "", env: { PATH: "/bin" }, platform: "linux" });
    assert.equal(configured.command, "nano");
    assert.equal(resolveEditorCommand({ settingsEditor: "sh", visual: "", editor: "", env: { PATH: "/bin" } }).runnable, Boolean(whichExecutable("sh")));
  });

  it("HARNESS-012: the editor quit keys are derived from the resolved editor, never hard-coded", () => {
    assert.deepEqual(quitSequenceFor("micro").quit, ["ctrl+q"]);
    assert.deepEqual(quitSequenceFor("/nix-profile/bin/micro").quit, ["ctrl+q"]);
    assert.deepEqual(quitSequenceFor("nano").quit, ["ctrl+x"]);
    assert.deepEqual(quitSequenceFor("vi -f").quit, [":q!", "enter"]);
    assert.equal(quitSequenceFor("some-unknown-editor").known, false);
    assert.deepEqual(quitSequenceFor("some-unknown-editor").quit, ["ctrl+c"]);
  });

  it("GATE-001: the live smoke resolves an editor and records it instead of accepting an override variable", async () => {
    const source = await readFile(new URL("../scripts/benchmark/smoke-live.mjs", import.meta.url), "utf8");
    assert.equal(source.includes("PI_BENCHMARK_EDITOR"), false, "the bespoke editor override must be gone");
    const driver = await readFile(new URL("../scripts/benchmark/live-driver.mjs", import.meta.url), "utf8");
    assert.equal(/requestKey\("ctrl\+q",\s*"ask the editor to quit"\)/.test(driver), false, "the hard-coded editor quit key must be gone");
  });
});

describe("ledger: report and gate defects", () => {
  it("GATE-004: --verify has no opt-out switch and fails when the release gates are unmet", async () => {
    const source = await readFile(new URL("../scripts/benchmark/report.mjs", import.meta.url), "utf8");
    assert.equal(source.includes("PI_REQUIRE_RELEASE"), false, "release readiness must not be behind an env switch");
    const corpus = generateCorpus({ count: 5, seed: 7 });
    const report = await buildAggregateReport({
      corpus,
      results: { kind: "benchmark-comparison", cases: corpus.scenarios.map((scenario) => ({ id: scenario.id, pass: true })) },
      defects: [],
      liveSmoke: { status: "failed", observedAt: new Date().toISOString(), details: "x" },
    });
    assert.equal(report.releaseReady, false);
  });

  it("GATE-005: every corpus scenario must carry a terminal outcome in the results", () => {
    const corpus = generateCorpus({ count: 6, seed: 7 });
    const report = { comparison: { cases: corpus.scenarios.slice(0, 3).map((scenario) => ({ id: scenario.id, terminalOutcome: "completed" })) } };
    assert.throws(() => verifyTerminalOutcomes(corpus, report), /terminal_outcomes|terminal outcome/);
    const complete = { comparison: { cases: corpus.scenarios.map((scenario) => ({ id: scenario.id, terminalOutcome: "completed" })) } };
    assert.equal(verifyTerminalOutcomes(corpus, complete).cases, 6);
    const missing = { comparison: { cases: corpus.scenarios.map((scenario) => ({ id: scenario.id, terminalOutcome: scenario.id.endsWith("1") ? null : "completed" })) } };
    assert.throws(() => verifyTerminalOutcomes(corpus, missing), /no terminal outcome/);
  });

  it("GATE-006: a resolved critical defect must name a regression test that exists, and its numbers must match the run", () => {
    const ledger = [
      { id: "X-001", severity: "P1", status: "resolved", summary: "fixed" },
      { id: "X-002", severity: "P1", status: "resolved", summary: "fixed", regressionTest: "does-not-exist.test.mjs" },
      { id: "X-003", severity: "P1", status: "resolved", summary: "fixed", regressionTest: "benchmark-regressions.test.mjs" },
    ];
    assert.throws(() => verifyDefectLedger([ledger[0]]), /without a regressionTest/);
    assert.throws(() => verifyDefectLedger([ledger[1]]), /does not exist/);
    assert.equal(verifyDefectLedger([ledger[2]]).defects, 1);
    const drifted = [{ id: "X-004", severity: "P1", status: "resolved", summary: "s", regressionTest: "benchmark-regressions.test.mjs", claim: { candidateWins: 65 } }];
    assert.throws(() => verifyDefectLedger(drifted, { judged: { candidateWins: 68, judgedCases: 200, candidateWinRate: 0.34, wilson95LowerBound: 0.27 } }), /claim.candidateWins 65 != measured 68/);
  });

  it("CORPUS-001: regenerating the corpus reproduces the shipped Space Bunny Alpha corpus from the repository", async () => {
    const durable = await loadDurableCorpus({ count: 1000, seed: 20260925 });
    assert.ok(durable, `${DURABLE_CORPUS_PATH} must be present in the repository`);
    assert.equal(durable.count, 1000);
    assert.deepEqual(durable.strata, { ordinary: 700, visual: 200, adversarial: 100 });
    assert.equal(durable.provenance.generator, "space-bunny-alpha");
    assert.equal(new Set(durable.scenarios.map((scenario) => scenario.id)).size, 1000);
    // A different seed must not silently return the shipped corpus.
    assert.equal(await loadDurableCorpus({ count: 1000, seed: 999 }), null);
  });

  it("EVID-001: the published evidence index is self-verifying", async () => {
    const result = await verifyEvidence();
    assert.equal(result.verified, true);
    assert.ok(result.artifacts >= 8, "the mirror must carry the report, ledger, corpus, results, manifest and judging");
    assert.ok(result.samples >= 1, "at least one generated image is published for inspection");
  });
});

describe("ledger: harness defects", () => {
  it("HARNESS-001: image and result counts are recomputed from the artifacts, never self-reported", async () => {
    const empty = await ingestImageManifest(manifestFor(smallCorpus(), { keys: [] }), { max: 600 });
    assert.equal(empty.generated, 0);
    assert.equal(empty.images.length, 0);
  });

  it("HARNESS-002: --passes is the number of executions recorded, not a label", async () => {
    const corpus = generateCorpus({ count: 4, seed: 7 });
    const single = await compareCorpus(corpus, { passes: 1, blind: false });
    const double = await compareCorpus(corpus, { passes: 2, blind: false });
    assert.equal(single.cases[0].passesExecuted, 1);
    assert.equal(double.cases[0].passesExecuted, 2);
  });

  it("HARNESS-003/HARNESS-006: a reserved label is legal in a corpus whose purpose is to probe its rejection", () => {
    const corpus = generateCorpus({ count: 4, seed: 7 });
    corpus.scenarios[0].canonicalInput.questions[0].options.push({ label: "Other", description: "probes the reserved label" });
    corpus.scenarios[0].inputValid = false;
    // A scenario that carries a reserved label has to be local-only, or the
    // corpus is comparing a hostile label across a boundary it was never meant
    // to cross. Without this the corpus below is rejected for an unrelated
    // reason and the assertion passes for the wrong one.
    corpus.scenarios[0].comparisonScope = "local-only";
    corpus.scenarios[0].expected = { outcome: "invalid", oracle: "exact", classification: "rejected-before-ui", answers: [] };
    // The assertion used to be `assert.doesNotThrow(() => { import(...) })` -
    // a bare, non-awaited dynamic import of a module already loaded at the top
    // of this file. `corpus` was never handed to anything, and `validateCorpus`
    // in fact *rejects* the object this test builds. So the test named as the
    // regression guard for two P0 harness defects could not fail, whatever
    // `validateCorpus` did.
    assert.equal(validateCorpus(corpus), true, "a local-only invalid scenario may carry a reserved label");
    const crossing = generateCorpus({ count: 4, seed: 7 });
    crossing.scenarios[0].canonicalInput.questions[0].options.push({ label: "Other", description: "probes the reserved label" });
    crossing.scenarios[0].inputValid = false;
    crossing.scenarios[0].expected = { outcome: "invalid", oracle: "exact", classification: "rejected-before-ui", answers: [] };
    assert.throws(() => validateCorpus(crossing), /local-only/, "and the same label is still refused when the scenario is not local-only");
  });

  it("HARNESS-009: an existing imported corpus is re-validated rather than silently overwritten", async () => {
    const directory = await mkdtemp(join(tmpdir(), "corpus-"));
    const target = join(directory, "corpus.json");
    await writeFile(target, JSON.stringify({ ...generateCorpus({ count: 3, seed: 7 }), provenance: { generator: "space-bunny-alpha" } }));
    const { main } = await import("../scripts/benchmark/corpus.mjs");
    const lines = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
    try { await main(["--out", target]); } finally { process.stdout.write = original; }
    assert.match(lines.join(""), /revalidated/);
  });

  it("HARNESS-011: --verify takes the report path as a value, not a boolean", async () => {
    const { parseArgs } = await import("../scripts/benchmark/common.mjs");
    const parsed = parseArgs(["--verify", ".pi/benchmark/report.json"], { verify: "string" });
    assert.equal(parsed.verify, ".pi/benchmark/report.json");
  });

  it("GATE-002: an open P0/P1 is reported as data and only fails the release gate", () => {
    const report = {
      schemaVersion: 1, kind: "benchmark-aggregate-report",
      corpus: { count: 1000, strata: { ordinary: 700, visual: 200, adversarial: 100 } },
      comparison: { deterministicAccuracy: 1, wilson95LowerBound: 0.99 },
      defects: [{ id: "OPEN-1", severity: "P1", status: "open", summary: "s" }],
      gates: { accuracy: true },
      releaseReady: false,
      liveSmoke: { status: "passed", observedAt: new Date().toISOString(), details: "x" },
    };
    const result = verifyAggregateReport(report);
    assert.equal(result.verified, true);
    assert.deepEqual(result.unresolvedCritical, ["OPEN-1"]);
    assert.equal(result.releaseReady, false);
  });

  it("HARNESS-005: a multi-select stage with no recorded answer terminates instead of looping", async () => {
    const scenario = {
      id: "m-1", stratum: "adversarial", classification: "staged", comparisonScope: "local-only", inputValid: true,
      canonicalInput: {
        reviewId: "m-1", title: "m", stages: [{
          id: "s1", kind: "choice", header: "S", prompt: "Pick", multiSelect: true,
          options: [{ key: "a", label: "Alpha", description: "a" }, { key: "b", label: "Beta", description: "b" }], allowOther: false, allowRevision: false, required: true,
        }],
      },
      expected: { outcome: "completed", oracle: "terminal-only", classification: "source-terminal-only", answers: [] },
      terminalConstraints: { requiresRealTTY: false, requiresConfiguredEditor: false, maxStages: 6, explicitApproval: true },
      visualPrompt: { required: false, prompt: null, comparisonRubric: [] },
    };
    const local = await runLocal(scenario);
    assert.ok(local.result.status, "the run must reach a terminal status");
  });

  it("HARNESS-010/HARNESS-007: the live driver records the editor it resolved and the quit keys it derived", async () => {
    const driver = await readFile(new URL("../scripts/benchmark/live-driver.mjs", import.meta.url), "utf8");
    assert.match(driver, /editorQuitKeys/);
    assert.match(driver, /resolveEditorCommand/);
    assert.match(driver, /never returned/);
  });

  it("HARNESS-004: the RPiV adapter preserves previews, notes and multi-select instead of dropping them", async () => {
    const source = await readFile(new URL("../scripts/benchmark/reference.mjs", import.meta.url), "utf8");
    assert.match(source, /preview/);
    assert.match(source, /multiSelect|multi-select/);
  });

  it("HARNESS-008: the image pipeline has no provider-call kill switch left in the contract command", async () => {
    const source = await readFile(new URL("../scripts/benchmark/images.mjs", import.meta.url), "utf8");
    assert.equal(source.includes("provider_calls_disabled"), false);
  });

  it("HARNESS-007: the corpus plan is three prompts per visual scenario, deduplicated by prompt hash", () => {
    const corpus = generateCorpus({ count: 100, seed: 7 });
    const planned = planImages(corpus, { limit: 600 });
    const visual = corpus.scenarios.filter((scenario) => scenario.stratum === "visual");
    assert.equal(planned.length, visual.length * 3);
    assert.equal(new Set(planned.map((item) => item.hash)).size, planned.length);
  });
});

describe("ledger: the shipped ledger itself", () => {
  it("GATE-007: every resolved critical defect in .pi/benchmark/defects.json names a test that exists in this file", async () => {
    let ledger;
    try {
      ledger = JSON.parse(await readFile(new URL("../.pi/benchmark/defects.json", import.meta.url), "utf8"));
    } catch {
      return; // The ledger is produced by the run; nothing to check yet.
    }
    const source = await readFile(new URL("./benchmark-regressions.test.mjs", import.meta.url), "utf8");
    const missing = ledger.defects
      .filter((defect) => (defect.severity === "P0" || defect.severity === "P1") && defect.status === "resolved")
      .filter((defect) => !defect.regressionTest || !source.includes(defect.id));
    assert.deepEqual(missing.map((defect) => defect.id), [], "resolved critical defects must be pinned by a named test in this file");
  });
});

describe("ledger: measurement-condition defects", () => {
  it("VISUAL-003: the judged image arm is the raster a terminal displays, not the untouched source file", async () => {
    const { decodePng, encodePng, previewCellGrid, renderAtTerminalDimensions, resampleArea } = await import("../scripts/benchmark/terminal-render.mjs");
    const grid = previewCellGrid({ columns: 110 });
    // The grid is the package's own: src/tui.ts renders the preview through
    // pi-tui with maxWidthCells = width - 2 and maxHeightCells = 16.
    assert.equal(grid.widthCells, 31);
    assert.equal(grid.heightCells, 16);
    assert.equal(grid.pixelWidth, 31 * 8);
    assert.equal(grid.pixelHeight, 16 * 16);
    // An area-average downscale of a 2x1 red/blue pair keeps both, where a point
    // sample would drop half the signal: the maths is pinned, not mocked.
    const stripes = { width: 2, height: 1, data: Buffer.from([255, 0, 0, 0, 0, 255]) };
    const averaged = resampleArea(stripes, 1, 1);
    assert.deepEqual([...averaged.data], [128, 0, 128]);
    // Encode/decode round-trips, and the render really is smaller than its source.
    const encoded = encodePng(stripes);
    assert.deepEqual([...decodePng(encoded).data], [...stripes.data]);
    const source = await readFile(new URL("../tests/fixtures/tui-smoke.png", import.meta.url));
    const rendered = renderAtTerminalDimensions(source, grid);
    assert.equal(rendered.width, grid.pixelWidth);
    assert.equal(rendered.height, grid.pixelHeight);
    assert.ok(rendered.source.width > rendered.width, "the judged raster must be the downscale, not the source");
    assert.deepEqual([...rendered.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  it("VISUAL-003: the baseline arm is the text the package renders today, not a hand-written summary", async () => {
    const { renderTextArm, wrapText } = await import("../scripts/benchmark/text-arm.mjs");
    const review = VISUAL_SCENARIO.canonicalInput;
    const lines = renderTextArm(review, { columns: 110 });
    assert.ok(lines.includes("> 1. Error recovery Inline"), "the selected row carries the TUI's selection marker and row number");
    assert.ok(lines.includes("  2. Error recovery Toast"), "unselected rows keep the TUI's two-space indent");
    assert.ok(lines.some((line) => line.startsWith("     An inline notice")), "descriptions keep the TUI's five-space indent");
    assert.ok(lines.includes("Preview: Error recovery Inline"), "the selected option's preview block is present");
    assert.ok(lines.includes("No inline preview supplied."), "an option with no preview says so, as fallbackPreview does");
    // Wrapping respects the column budget the text mode uses (columns - 2).
    assert.ok(wrapText("a ".repeat(200), 40).every((line) => line.length <= 40));
    // A body character must never exceed the budget.
    assert.ok(wrapText("word ".repeat(200), 40).every((line) => line.length <= 40));
    assert.ok(wrapText("   indented words here", 40)[0].startsWith("   "), "indent survives wrapping");
  });

  it("VISUAL-004: severe failure is attributed through the label map, so the 2% cap is measurable", async () => {
    const { attributeSevereFailure } = await import("../scripts/benchmark/judge.mjs");
    // The judge names arms; the summary used to look for "candidate", so the
    // rate was structurally zero no matter what the judge reported.
    assert.deepEqual(attributeSevereFailure("B", { A: "candidate", B: "reference" }, "legibility"),
      { label: "B", kind: "legibility", candidate: false, reference: true, raw: "B" });
    assert.deepEqual(attributeSevereFailure("B", { A: "reference", B: "candidate" }, "legibility"),
      { label: "B", kind: "legibility", candidate: true, reference: false, raw: "B" });
    assert.equal(attributeSevereFailure("both", { A: "candidate", B: "reference" }, "answerability").candidate, true);
    assert.equal(attributeSevereFailure("none", { A: "candidate", B: "reference" }).candidate, false);
  });

  it("VISUAL-008: the severe ceiling reads the legibility class, and an unclassified call is never softer than legibility", async () => {
    const { judgeSummary, attributeSevereFailure } = await import("../scripts/benchmark/judge.mjs");
    const call = (kind) => ({ winner: "A", candidate: true, severeFailure: attributeSevereFailure("A", { A: "candidate" }, kind) });
    const results = [call("legibility"), call("discriminability"), call("answerability"), call("none"), call("answerability")];
    const summary = judgeSummary(results);
    // Five severe calls, one of them legibility: the gate reads the class the
    // objective bounds, and a dispute whose class nobody could establish is
    // counted on its own line instead of being charged to the image.
    assert.equal(summary.severeImageFailures, 5);
    assert.equal(summary.severeLegibilityFailures, 1);
    assert.equal(summary.severeLegibilityFailureRate, 0.2);
    assert.equal(summary.severeByKind.answerability, 2);
    assert.equal(summary.severeByKind.discriminability, 1);
    assert.equal(summary.unestablishedSevereFailures, 1);
    assert.equal(summary.unestablishedSevereFailureRate, 0.2);
  });

  it("VISUAL-009 (JUDGE-006): a severity dispute the adjudicator could not settle is never charged to the legibility class", async () => {
    const { adjudicate, judgeSummary } = await import("../scripts/benchmark/judge.mjs");
    const pass = (winner, severeFailure) => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure, severeKind: severeFailure === "none" ? "none" : "legibility", rationale: "r" });
    const labels = { A: "candidate", B: "reference" };
    // Two passes disagree about severity and the adjudicator never answered.
    const unresolved = adjudicate([pass("A", "A"), pass("A", "B")], labels, null);
    assert.equal(unresolved.severeFailure.candidate, true);
    assert.equal(unresolved.severeFailure.kind, "none");
    const summary = judgeSummary([unresolved]);
    assert.equal(summary.severeImageFailures, 1, "the dispute is still a severe call");
    assert.equal(summary.severeLegibilityFailures, 0, "but it is not evidence that the image was unreadable");
    assert.equal(summary.unestablishedSevereFailures, 1);
  });

  it("JUDGE-005: a contested severity call escalates to the adjudicator and is never silently charged to both arms", async () => {
    const { adjudicate, judgeSummary } = await import("../scripts/benchmark/judge.mjs");
    const pass = (winner, severeFailure, severeKind = "none") => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure, severeKind, rationale: "r" });
    const labels = { A: "candidate", B: "reference" };
    const settled = adjudicate([pass("A", "A"), pass("A", "B")], labels, pass("A", "B"));
    assert.equal(settled.method, "adjudicated-severity");
    assert.equal(settled.severeFailure.candidate, false, "the adjudicator's call decides, not a default");
    const contested = adjudicate([pass("A", "A"), pass("A", "B")], labels);
    assert.equal(contested.method, "contested-severity");
    assert.equal(contested.severeFailure.candidate, true, "an unbreakable split is charged to both, conservatively");
    const summary = judgeSummary([settled, contested]);
    assert.equal(summary.severeImageFailures, 1);
    assert.equal(summary.severeReferenceFailures, 2);
  });

  it("GATE-004: --verify recomputes the gates from the artifacts and rejects a self-certified report", async () => {
    const { recomputeFromSources } = await import("../scripts/benchmark/report.mjs");
    const corpus = smallCorpus(5);
    const manifest = manifestFor(corpus);
    const results = { kind: "benchmark-comparison", cases: corpus.scenarios.map((scenario) => ({ id: scenario.id, pass: true })), passes: { requested: 2, executedPerCase: 2 }, reference: { adapter: "test", sharedCases: 0 } };
    const judging = { model: { provider: "p", model: "m" }, summary: { judgedCases: 200, candidateWins: 130, candidateWinRate: 0.65, wilson95LowerBound: 0.58, severeImageFailureRate: 0 }, results: [] };
    const directory = await mkdtemp(join(tmpdir(), "verify-"));
    const paths = {};
    for (const [name, value] of Object.entries({ "corpus.json": corpus, "results.json": results, "image-manifest.json": manifest, "judge.json": judging })) {
      paths[name] = join(directory, name);
      await writeFile(paths[name], JSON.stringify(value));
    }
    const reportPath = join(directory, "report.json");
    // An honest report: the corpus is too small for the 1% accuracy gate, so the
    // recomputed verdict is not ready and the report says so.
    const honest = {
      schemaVersion: 1, kind: "benchmark-aggregate-report",
      sources: { corpus: "corpus.json", results: "results.json", images: "image-manifest.json", judging: "judge.json" },
      defects: [], liveSmoke: { status: "passed", observedAt: new Date().toISOString(), details: "x" },
      images: { visualUplift: 0.65 },
      // Five passing cases cannot clear the 1% accuracy lower bound, so confidenceBound is the gate that fails.
      gates: { visualUplift: true, visualConfidence: true, severeFailures: true, accuracy: true, confidenceBound: false },
      releaseReady: false,
    };
    await writeFile(reportPath, JSON.stringify(honest));
    const ok = await recomputeFromSources(honest, reportPath);
    assert.equal(ok.releaseReady, false);
    assert.equal(ok.measuredUplift, 0.65);
    assert.equal(ok.gates.severeFailures, true, "a 0% severe rate recomputes as passing the 2% cap");
    // The self-certification the auditor found: a report that claims a passing
    // verdict its own artifacts contradict is a failure, not a pass.
    const lying = { ...honest, releaseReady: true };
    await assert.rejects(() => recomputeFromSources(lying, reportPath), /releaseReady claims true, recomputed false/);
    const wrongUplift = { ...honest, images: { visualUplift: 0.2 } };
    await assert.rejects(() => recomputeFromSources(wrongUplift, reportPath), /claims 0.2, recomputed 0.65/);
    const wrongGate = { ...honest, gates: { ...honest.gates, severeFailures: false } };
    await assert.rejects(() => recomputeFromSources(wrongGate, reportPath), /gate:severeFailures/);
    // A report whose named artifacts cannot be found is refused outright rather
    // than verified on the strength of its own claims.
    const empty = await mkdtemp(join(tmpdir(), "verify-empty-"));
    await writeFile(join(empty, "report.json"), JSON.stringify(honest));
    await assert.rejects(() => recomputeFromSources(honest, join(empty, "report.json")), /missing: corpus/);
  });

  it("GATE-008: the image generation account survives pruning and never understates consumption", async () => {
    const { generationAccounting, recordGenerationAccount } = await import("../scripts/benchmark/images.mjs");
    const directory = await mkdtemp(join(tmpdir(), "images-"));
    const ledger = join(directory, "generations.json");
    const manifest = { images: [{ path: join(directory, "keep.png") }], failures: [] };
    await writeFile(join(directory, "keep.png"), "x");
    await writeFile(join(directory, "orphan.png"), "x");
    const before = await recordGenerationAccount(manifest, { imageDir: directory, ledger });
    assert.equal(before.cumulativeSuccessfulGenerations, 2);
    const { unlink } = await import("node:fs/promises");
    await unlink(join(directory, "orphan.png"));
    const after = await generationAccounting(manifest, { imageDir: directory, ledger });
    assert.equal(after.cumulativeSuccessfulGenerations, 2, "deleting an orphan must not erase that it was generated");
    assert.equal(after.supersededGenerationsAlreadyDeleted, 1);
  });
});

/**
 * VISUAL-006: the image prompt is written in the units the terminal can resolve.
 *
 * Root cause of the 34.5% severe rate: the style asked for a full-density
 * interface mockup - "thin dark outlines", "fill the frame", placeholder words
 * in the chrome - and the judge sees that art on the 31 x 16 cell grid, about
 * 248 x 256 pixels. A hairline is a quarter of a display pixel wide and a
 * full-density mockup is texture at that size, so the three treatments of a
 * scenario measured as three shades of the same grey. The prompt now names a
 * countable composition, a hard ceiling on shapes, thick strokes, and wide gaps,
 * and the tests below pin each of those so a later "prettier prompt" cannot
 * quietly reintroduce the defect.
 */
describe("VISUAL-006: the image prompt is written for the display it is judged at", () => {
  it("VISUAL-006: every prompt carries a countable composition and the display budget", async () => {
    const VISUAL_SCENARIOS = await corpusVisualScenarios(24);
    assert.ok(VISUAL_SCENARIOS.length > 0, "the visual stratum must not be empty");
    for (const scenario of VISUAL_SCENARIOS) {
      for (const option of scenario.canonicalInput.stages[0].options) {
        const prompt = imageOptionPrompt(scenario, option);
        assert.match(prompt, /Draw exactly this composition and nothing else/);
        // A composition is countable. "A well-organised interface" is not.
        assert.match(prompt, /\b(one|two|three|four|five|six|nine)\b[^.]*\b(block|panel|cell|tile|circle|bar|band|band|disc|rectangle)/i,
          `${scenario.id}/${option.label} has no countable composition`);
        assert.match(prompt, /between twelve and twenty shapes/i);
        assert.match(prompt, /wide white gaps/i);
        assert.match(prompt, /thick black outlines/i);
        // The hairline style that measured as texture is gone for good.
        assert.doesNotMatch(prompt, /thin dark outline/i);
        assert.doesNotMatch(prompt, /fill the frame: every region/i);
        // And so is the word list. "One large word per block, from this list" is
        // what produced the fake UI text: a model given nothing to say fills
        // blocks with status words, and the measured result was cards reading
        // "OK / SAFE LOW" for a bus-operations dashboard.
        assert.doesNotMatch(prompt, /LATE, OK, HOLD/, "the status-word list is what made the previews look like UI");
        assert.match(prompt, /Text: none at all/, "and the prompt now says so outright");
        // The prompt is deterministic: the cache and the 600-image budget both
        // depend on the same scenario producing the same string.
        assert.equal(prompt, imageOptionPrompt(scenario, option));
      }
    }
  });

  it("VISUAL-006: the three treatments of a case never share a composition", async () => {
    for (const scenario of await corpusVisualScenarios(24)) {
      const options = scenario.canonicalInput.stages[0].options;
      const compositions = compositionsFor(options);
      assert.equal(new Set(compositions.map((item) => item.family)).size, options.length,
        `${scenario.id} draws two of its treatments the same way: ${JSON.stringify(compositions)}`);
    }
  });

  it("VISUAL-006: a forced composition is recorded, never silently substituted", () => {
    const options = [
      { key: "a", label: "Board Alpha", description: "A wide band across the top with two blocks below." },
      { key: "b", label: "Board Beta", description: "A wide band across the top with two blocks below." },
      { key: "c", label: "Board Gamma", description: "A 3x3 grid of cells." },
    ];
    const resolved = compositionsFor(options);
    const spread = resolved.filter((item) => item.source.endsWith("+spread"));
    assert.equal(spread.length, 1, "a shared treatment must be spread onto another arrangement");
    assert.equal(new Set(resolved.map((item) => item.family)).size, 3);
  });

  it("VISUAL-006: the negative prompt is part of the request and of the cache key", async () => {
    const planned = planImages({ scenarios: await corpusVisualScenarios(24) }, { limit: 600 });
    for (const item of planned) {
      assert.equal(typeof item.negativePrompt, "string");
      assert.ok(item.negativePrompt.length > 0);
      // The key covers both halves: a negative-prompt revision must not be
      // served from a cache built for the previous one.
      assert.equal(item.hash, promptHash(item));
      assert.notEqual(promptHash({ prompt: item.prompt }), item.hash);
      assert.equal(promptHash({ prompt: item.prompt, negativePrompt: item.negativePrompt }), item.hash);
    }
  });
});

/**
 * VISUAL-007: the shipped preview composes art into the package's own structure.
 *
 * Root cause: the 2% severe ceiling is unreachable for a raw generated preview,
 * because a 248 x 256 raster can carry a shape and an emphasis but not the
 * information the question asks about - the judge charged 34.5% of raw
 * previews for exactly that, with "abstract placeholder-like symbols" in its
 * own words. The product therefore draws the information-bearing layer
 * deterministically and places the art inside it. These tests pin the parts
 * that make that a real product path rather than a benchmark trick: the
 * composition is a pure function of (spec, art), the art is cropped rather than
 * squashed, the structure survives compositing, and an option that asks for both
 * gets the composition instead of silently losing one of the two.
 */
describe("VISUAL-007: the composed preview is a deterministic product path", () => {
  const spec = { layout: "list", rows: [
    { code: "01", label: "ROUTE 4", value: 0.9, status: "danger" },
    { code: "02", label: "ROUTE 7", value: 0.4, status: "ok" },
    { code: "03", label: "ROUTE 9", value: 0.6, status: "warn" },
  ] };

  it("VISUAL-007: the same spec and art compose to byte-identical bytes", () => {
    const art = { width: 64, height: 48, data: Buffer.alloc(64 * 48 * 3).fill(120) };
    const first = composePreview({ spec, art });
    const second = composePreview({ spec, art });
    assert.equal(first.png.equals(second.png), true, "composition must be reproducible");
    assert.equal(first.width, 31 * 8);
    assert.equal(first.height, 16 * 16);
  });

  it("VISUAL-007: the art is cropped to fill, never squashed", () => {
    const wide = { width: 200, height: 20, data: Buffer.alloc(200 * 20 * 3, 200) };
    // A squashed 10:1 source into a 3:2 target would come out with a changed
    // aspect; the crop keeps it, which is why the shape is preserved.
    assert.equal(cropped.width, 60);
    assert.equal(cropped.height, 40);
  });

  it("VISUAL-007: the structure survives compositing, so a preview is never less informative than text", () => {
    const art = { width: 32, height: 32, data: Buffer.alloc(32 * 32 * 3, 30) };
    const plain = renderMockup(spec);
    const composed = composePreview({ spec, art });
    // The row band below the art still carries ink: a preview that art covered
    // completely would be the regression this composition exists to prevent.
    const decoded = decodePng(composed.png);
    let ink = 0;
    for (let y = 8 * 16; y < decoded.height; y += 1) {
      for (let x = 0; x < decoded.width; x += 1) {
        const index = (y * decoded.width + x) * 3;
        if (decoded.data[index] < 120 || decoded.data[index + 1] < 120 || decoded.data[index + 2] < 120) ink += 1;
      }
    }
    assert.ok(ink > 200, `composed preview lost its structure: ${ink} ink pixels below the art band`);
    assert.ok(plain.png.length > 0);
  });

  it("VISUAL-007: an option that asks for both a mockup and a generation gets the composition", async () => {
    const { generateReviewImages } = await import("../src/image-generator.ts");
    const artPng = encodePng({ width: 32, height: 32, data: Buffer.alloc(32 * 32 * 3, 200) });
    const fetchImpl = async () => new Response(JSON.stringify({ data: [{ b64_json: artPng.toString("base64") }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
    const directory = await mkdtemp(join(tmpdir(), "composed-"));
    const review = {
      version: 1, reviewId: "r", round: 1, provider: "agnes", model: "agnes-image-2.5-flash",
      title: "Composed", notes: "",
      stages: [{
        id: "s", kind: "draft", header: "Layout", prompt: "Pick a layout", required: true,
        multiSelect: false, allowOther: false, allowRevision: false, allowSkip: false,
        options: [{ id: "a", label: "Split", description: "Two panels", mockup: spec, generate: { prompt: "a mockup", provider: "agnes" } }],
      }],
    };
    const result = await generateReviewImages(review, {
      cwd: process.cwd(), outputDir: directory, fetchImpl, resolveCredential: () => "test-key", timeoutMs: 5000,
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].provider, "composed");
    assert.match(result.images[0].model, /^deterministic-cell-renderer\+/);
    const written = await readFile(result.images[0].path);
    assert.equal(detectImage(written).mimeType, "image/png");
    // The composited option no longer asks for a second generation.
    assert.equal(result.review.stages[0].options[0].generate, undefined);
    assert.equal(result.review.stages[0].options[0].mockup, undefined);
  });
});


/**
 * VISUAL-005: the restated visual criterion, pinned so it cannot drift.
 *
 * The 60% / 50% pair was measured unreachable on a 248 x 256 pixel preview
 * (46.0% for the image arm, 54.5% for the composed preview, 47.0% for the
 * structure alone, all against the same text baseline), and the owner restated
 * it to the floor of that range. A restated gate that quietly tracked the
 * measurement would be worse than the gate it replaced, so these tests pin the
 * constants and prove they still fail when an arm is worse than the floor.
 */
describe("VISUAL-005: the restated visual criterion is a constant, not a moving target", () => {
  it("VISUAL-005: the thresholds are the restated ones, and the deterministic ones never moved", async () => {
    const { GATES } = await import("../scripts/benchmark/report.mjs");
    assert.equal(GATES.visualWinRate, 0.45);
    assert.equal(GATES.visualWinRateLowerBound, 0.35);
    assert.equal(GATES.severeFailureRate, 0.02);
    assert.equal(GATES.judgedVisualCases, 200);
    // Untouched by the restatement.
    assert.equal(GATES.deterministicAccuracy, 1);
    assert.equal(GATES.wilsonLowerBound, 0.95);
  });

  it("VISUAL-005: the win gate still fails below the restated floor, and the ceiling still fails above 2% legibility", async () => {
    const { recomputeImages } = await import("../scripts/benchmark/report.mjs");
    // recomputeImages takes the judging report, not its summary.
    const judged = (wins, legibility) => ({ summary: {
      judgedCases: 200, decidedCases: 200, candidateWins: wins, candidateWinRate: wins / 200,
      wilson95LowerBound: wins / 200 - 0.05, ties: 0, undecided: 0, judgeErrors: 0,
      severeImageFailures: 0, severeImageFailureRate: 0, severeLegibilityFailures: legibility,
      severeLegibilityFailureRate: legibility / 200, severeByKind: { legibility: legibility },
      unestablishedSevereFailures: 0,
    } });
    const manifest = { images: new Array(600).fill({}), failures: [] };
    const passing = recomputeImages(manifest, judged(92, 4));
    assert.equal(passing.gates.visualUplift, true, "46.0% is the measured floor and passes");
    assert.equal(passing.gates.confidenceBound, true);
    assert.equal(passing.gates.severeFailures, true, "4/200 legibility is inside the 2% ceiling");
    const weak = recomputeImages(manifest, judged(80, 4));
    assert.equal(weak.gates.visualUplift, false, "40% is below the floor and must still fail");
    const blurry = recomputeImages(manifest, judged(92, 8));
    assert.equal(blurry.gates.severeFailures, false, "4% legibility must still fail the 2% ceiling");
  });

  it("VISUAL-005: the defect ledger resolves against the same constants the gate enforces", async () => {
    const { GATES } = await import("../scripts/benchmark/report.mjs");
    const { buildDefectLedger } = await import("../scripts/benchmark/ledger.mjs");
    const judged = (wins, legibility) => ({
      judgedCases: 200, decidedCases: 200, candidateWins: wins, candidateWinRate: wins / 200,
      wilson95LowerBound: wins / 200 - 0.05, ties: 0, undecided: 0, judgeErrors: 0,
      severeImageFailures: 0, severeImageFailureRate: 0, severeLegibilityFailures: legibility,
      severeLegibilityFailureRate: legibility / 200, severeByKind: { legibility: legibility },
      unestablishedSevereFailures: 0,
    });
    const atFloor = buildDefectLedger({ judged: judged(92, 4) }).defects.find((item) => item.id === "VISUAL-001");
    assert.equal(atFloor.status, "resolved", "the ledger must agree with a gate that passes");
    const belowFloor = buildDefectLedger({ judged: judged(80, 4) }).defects.find((item) => item.id === "VISUAL-001");
    assert.equal(belowFloor.status, "open", "and must still open when the gate fails");
    const overCeiling = buildDefectLedger({ judged: judged(92, 8) }).defects.find((item) => item.id === "VISUAL-001");
    assert.equal(overCeiling.status, "open", "and when the legibility ceiling is exceeded");
    assert.equal(GATES.visualWinRate, 0.45);
  });
});

/**
 * BUDGET-001: the image budget gate reads provider consumption, not a cache file.
 *
 * The gate used to compare one manifest's entry count with 600 - a comparison
 * that cannot fail, because a manifest is capped at 600 by construction - while
 * the ledger recorded 2,020 real generations. It also had no blinded win-or-tie
 * metric at all, which the comparison contract asks for.
 */
describe("BUDGET-001: the budget gate counts generations, and the comparison reports win-or-tie", () => {
  const SMALL = smallCorpus();
  const manifest = manifestFor(SMALL);
  const judged = { summary: { judgedCases: 200, decidedCases: 200, candidateWins: 130, candidateWinRate: 0.65, wilson95LowerBound: 0.58, ties: 0, undecided: 0, judgeErrors: 0, severeImageFailures: 0, severeImageFailureRate: 0, severeLegibilityFailures: 0, severeLegibilityFailureRate: 0 } };
  const results = {
    kind: "benchmark-comparison",
    cases: SMALL.scenarios.map((scenario) => ({ id: scenario.id, pass: true, stableAcrossPasses: true })),
    reference: { adapter: "fixture", sharedCases: 333, losses: [] },
    summary: { shared: { total: 333, passed: 333, referenceLosses: 0 } },
  };
  const liveSmoke = { status: "passed", observedAt: new Date().toISOString(), details: "x" };

  it("BUDGET-001: the boundary reads generations after the accepted baseline, and a full win-or-tie passes it", async () => {
    const { buildAggregateReport, recomputeWinOrTie } = await import("../scripts/benchmark/report.mjs");
    // The owner moved the boundary onto cumulative generations and accepted the
    // 2,020 already spent. The gate therefore reads what came after it.
    const baseline = { cumulativeSuccessfulGenerations: 2020, boundaryBaselineGenerations: 2020 };
    const clean = await buildAggregateReport({
      corpus: SMALL, results, manifest, judging: judged, liveSmoke, defects: [],
      generationAccount: { ...baseline, currentSetGenerations: 600 },
    });
    assert.equal(clean.gates.imageBudget, true);
    assert.equal(clean.resources.generationsSinceBoundary, 0);
    // Spending more after the baseline fails, and the record keeps the total.
    const over = await buildAggregateReport({
      corpus: SMALL, results, manifest, judging: judged, liveSmoke, defects: [],
      generationAccount: { cumulativeSuccessfulGenerations: 2020 + 601, boundaryBaselineGenerations: 2020, currentSetGenerations: 601 },
    });
    assert.equal(over.gates.imageBudget, false, "the boundary must still be able to fail");
    assert.equal(over.resources.generationsSinceBoundary, 601);
    assert.equal(over.resources.cumulativeGenerations, 2621, "the total is never rewritten to look small");
    assert.equal(over.releaseReady, false);
    const within = await buildAggregateReport({
      corpus: SMALL, results, manifest, judging: judged, liveSmoke, defects: [],
      generationAccount: { cumulativeSuccessfulGenerations: 600, currentSetGenerations: 600 },
    });
    assert.equal(within.gates.imageBudget, true);
    const winOrTie = recomputeWinOrTie(within.comparison);
    assert.equal(winOrTie.sharedCases, 333);
    assert.equal(winOrTie.winOrTieRate, 1);
    assert.equal(winOrTie.candidateLosses, 0);
    assert.equal(winOrTie.gates.winOrTie, true);
    assert.ok(winOrTie.wilson95LowerBound > 0.5);
  });
});


/**
 * COMPARE-001: 53 shared cases disagreed with RPiV in envelope text, and the
 * adapter recorded only a count, so nobody had read them.
 *
 * The comparator now records every mismatch - case id, classification, both
 * texts - and sorts each one against a fixed rule. The rule itself had a defect
 * the first classification exposed: a multi-select value is a set, and
 * comparing it as a sequence called one case a capability difference when both
 * envelopes named the identical three answers and the case passed on answers.
 */
describe("COMPARE-001: every envelope mismatch is recorded and classified", () => {
  const envelope = (value, tail = "") => `User has answered your questions: "Pick every one that applies."="${value}". ${tail}`;

  it("COMPARE-001: the same multi-select answers in another order are wording, not a capability difference", () => {
    const reference = envelope("Add a summary page, Add a glossary, Rewrite and split", "You can now continue.");
    const local = envelope("Rewrite and split, Add a summary page, Add a glossary", "You can now continue.");
    const classified = classifyEnvelopeDifference(reference, local);
    assert.equal(classified.kind, "adapter-wording");
    assert.deepEqual(classified.onlyReference, []);
  });

  it("COMPARE-001: a genuinely different answer is a capability difference, and so is a missing one", () => {
    const one = classifyEnvelopeDifference(envelope("A, B"), envelope("A, C"));
    assert.equal(one.kind, "capability");
    assert.match(one.reason, /different answers/);
    // A one-sided answer is still a different answer, and the reason says so.
    const two = classifyEnvelopeDifference(envelope("A, B"), envelope("A"));
    assert.equal(two.kind, "capability");
    assert.match(two.reason, /different answers/);
    // A question the other envelope never reports at all is named explicitly.
    // A question the other envelope never reports at all is still a capability
    // difference, and the reason names the side that has the extra answer.
    const three = classifyEnvelopeDifference(
      '"First question"="A". "Second question"="B". ',
      '"First question"="A". ',
    );
    assert.equal(three.kind, "capability");
    assert.match(three.reason, /reference envelope reports an answer/);
    const four = classifyEnvelopeDifference(
      '"First question"="A". ',
      '"First question"="A". "Second question"="B". ',
    );
    assert.match(four.reason, /local envelope reports an answer/);
  });

  it("COMPARE-001: a block one envelope carries and the other does not is a disclosure difference", () => {
    const reference = envelope("A", "selected preview: Image reference.");
    const local = envelope("A");
    const classified = classifyEnvelopeDifference(reference, local);
    assert.equal(classified.kind, "disclosure");
    assert.ok(classified.onlyReferenceSections.length > 0);
  });

  it("COMPARE-001: the run records every mismatch with both texts, and none is dropped", async () => {
    const { readFile } = await import("node:fs/promises");
    const results = JSON.parse(await readFile(".pi/benchmark/results.json", "utf8"));
    const reference = results.reference;
    assert.ok(reference.envelopeMismatchRecords.length > 0, "there are shared cases to disagree on");
    assert.equal(reference.envelopeMismatchRecords.length, reference.envelopeMismatches, "the records are the mismatches");
    for (const record of reference.envelopeMismatchRecords) {
      assert.equal(typeof record.id, "string");
      // The contract's vocabulary: every mismatch is one of these two.
      assert.ok(["adapter-wording", "capability"].includes(record.classification), `${record.id} is unclassified`);
      // The finer reading of a wording difference is kept, not thrown away.
      assert.equal(typeof record.disclosure, "boolean");
      assert.ok(["image", "text", "legacy"].includes(record.scenario), `${record.id} lost its scenario class`);
      assert.ok(record.reason, `${record.id} has no reason`);
      assert.equal(typeof record.difference?.reference, "string", `${record.id} lost the reference envelope`);
      assert.equal(typeof record.difference?.local, "string", `${record.id} lost the local envelope`);
    }
    const cases = results.cases.filter((item) => item.envelopeMatch === false);
    assert.equal(cases.length, reference.envelopeMismatchRecords.length);
    for (const item of cases) {
      assert.equal(typeof item.envelopes?.reference, "string", `${item.id} lost the reference envelope`);
      assert.equal(typeof item.envelopes?.local, "string", `${item.id} lost the local envelope`);
    }
    // The counts and the records are two views of the same set.
    const counted = Object.values(reference.envelopeMismatchByClassification).reduce((sum, value) => sum + value, 0);
    assert.equal(counted, reference.envelopeMismatchRecords.length);
    const scenarios = Object.values(reference.envelopeMismatchByScenario).reduce((sum, value) => sum + value, 0);
    assert.equal(scenarios, reference.envelopeMismatchRecords.length);
    assert.equal(reference.envelopeMismatchDisclosures + (reference.envelopeMismatchByKind["adapter-wording"] ?? 0), reference.envelopeMismatchByClassification["adapter-wording"]);
    // The gate is on capability differences only, and wording is never a gate.
    assert.equal(reference.envelopeGate, reference.envelopeCapabilityMismatches.length === 0);
    assert.equal(reference.envelopeCapabilityMismatches.length, 0, "a shared case reporting different answers is a defect");
  });
});

/**
 * SMOKE-001: the live real-TTY run exercised the happy path and never a note, a
 * revision, a reject or a cancel - four behaviours the tool contract names. The
 * walk is now split into one real PTY session per review, and the plan those
 * sessions follow is data: the driver, the gate and this suite read one list, so
 * a behaviour cannot quietly leave the live run again.
 */
describe("SMOKE-001: the live smoke drives note, revision, reject and cancel on a real terminal", () => {
  const image = ".pi/benchmark/images/visual-001-option-1.png";
  /** Evidence shaped exactly the way the driver writes it. */
  const evidenceFor = (steps, rounds, extra = {}) => ({
    status: "passed", steps, errors: {}, assertions: {},
    session: { mode: "fixture", result: rounds.at(-1) ?? null, rounds },
    ...extra,
  });
  const passing = {
    note: evidenceFor(
      [{ step: "note", text: NOTE_TEXT, attached: true }],
      [{ status: "completed", decision: "approve", round: 1, answers: [{ stageId: "direction", answer: "Airy treatment", notes: NOTE_TEXT }] }],
    ),
    revision: evidenceFor(
      [{ step: "revision", feedback: REVISION_FEEDBACK }],
      [
        { status: "revision", decision: "revision", round: 1, revision: { stageId: "decision", feedback: REVISION_FEEDBACK, requestedRound: 2 } },
        { status: "completed", decision: "approve", round: 2, answers: [{ stageId: "decision", answer: "Grid layout" }] },
      ],
    ),
    reject: evidenceFor([{ step: "reject", endedBy: "the Reject review row" }], [{ status: "rejected", decision: "reject", round: 1 }]),
    cancel: evidenceFor([{ step: "cancel", endedBy: "Escape" }], [{ status: "cancelled", decision: "cancel", cancelled: true, round: 1 }]),
  };
  const clone = (value) => {
    const copy = JSON.parse(JSON.stringify(value));
    // The driver keeps `session.result` as the last round; a fixture that edits
    // its rounds has to stay consistent with it.
    copy.session.result = copy.session.rounds.at(-1) ?? null;
    return copy;
  };
  const planFor = (mode) => sessionPlan(mode, { imagePath: image });

  it("SMOKE-001: every missing behaviour is its own session, and the happy path keeps its eleven assertions", () => {
    assert.deepEqual([...BEHAVIOUR_SESSIONS], ["note", "revision", "reject", "cancel"]);
    assert.deepEqual([...SESSION_MODES], ["happy", "note", "revision", "reject", "cancel"]);
    // Reject and cancel end a review, so neither can share a walk with anything
    // else: each one gets a whole session of its own.
    const reviewIds = SESSION_MODES.map((mode) => planFor(mode).review.reviewId);
    assert.equal(new Set(reviewIds).size, SESSION_MODES.length, "two sessions cannot share a review id");
    for (const mode of BEHAVIOUR_SESSIONS) {
      const plan = planFor(mode);
      assert.equal(plan.step, mode, `${mode} must record a step named after itself`);
      assert.equal(plan.assertion, mode, `${mode} must contribute a named assertion`);
      assert.ok(plan.expect.length > 20, `${mode} must state what its evidence has to show`);
    }
    // The happy path contributes no new assertion and keeps the real image, so
    // the eleven assertions SMOKE-001 already proved are passed straight through.
    const happy = planFor(HAPPY_SESSION);
    assert.equal(happy.assertion, null);
    assert.deepEqual(happy.imageOption, { stageId: "direction", optionId: "airy" });
    assert.equal(happy.review.stages.length, 2);
    assert.throws(() => sessionPlan("nonsense"), /Unknown live session/);
  });

  it("SMOKE-001: a behaviour assertion passes only on the evidence its own walk recorded", () => {
    for (const mode of BEHAVIOUR_SESSIONS) {
      const plan = planFor(mode);
      assert.equal(verifySessionEvidence(plan, passing[mode]).passed, true, `${mode} fixture should pass`);
    }
    // The same reviews answered the old way must not satisfy the new steps.
    const approvedInstead = evidenceFor([], [{ status: "completed", decision: "approve", round: 1, answers: [] }]);
    assert.equal(verifySessionEvidence(planFor("reject"), approvedInstead).passed, false);
    assert.equal(verifySessionEvidence(planFor("cancel"), approvedInstead).passed, false);
    assert.equal(verifySessionEvidence(planFor("revision"), approvedInstead).passed, false);
    // A step that was never recorded is not a pass either.
    for (const mode of BEHAVIOUR_SESSIONS) {
      const withoutStep = clone(passing[mode]);
      withoutStep.steps = [];
      const verified = verifySessionEvidence(planFor(mode), withoutStep);
      assert.equal(verified.passed, false, `${mode} passed with no step recorded`);
      assert.ok(verified.reasons.some((reason) => reason.includes(`"${mode}"`)), `${mode} must say which step is missing`);
    }
  });

  it("SMOKE-001: a note is only a note when it reached the screen and came back on the answer", () => {
    const plan = planFor("note");
    const noAnswer = clone(passing.note);
    noAnswer.session.rounds[0].answers = [{ stageId: "direction", answer: "Airy treatment" }];
    const unverified = verifySessionEvidence(plan, noAnswer);
    assert.equal(unverified.passed, false);
    assert.ok(unverified.reasons.some((reason) => /carried the note back/.test(reason)));
    const unseen = clone(passing.note);
    unseen.steps[0].attached = false;
    const offScreen = verifySessionEvidence(plan, unseen);
    assert.equal(offScreen.passed, false);
    assert.ok(offScreen.reasons.some((reason) => /on-screen answer line/.test(reason)));
    const mismatched = clone(passing.note);
    mismatched.session.rounds[0].answers[0].notes = "a different note";
    const disagreed = verifySessionEvidence(plan, mismatched);
    assert.equal(disagreed.passed, false, "the note on screen and the note the tool returned must be the same one");
    assert.ok(disagreed.reasons.some((reason) => /carried the note back/.test(reason)));
  });

  it("SMOKE-001: a revision is only a round when the next round really ran and was approved", () => {
    const plan = planFor("revision");
    const singleRound = clone(passing.revision);
    singleRound.session.rounds.pop();
    singleRound.session.result = singleRound.session.rounds[0];
    const verified = verifySessionEvidence(plan, singleRound);
    assert.equal(verified.passed, false, "a revision request alone is not a revision round");
    assert.ok(verified.reasons.some((reason) => /no second round ran/.test(reason)));
    const staleRound = clone(passing.revision);
    staleRound.session.rounds[0].revision.requestedRound = 1;
    assert.equal(verifySessionEvidence(plan, staleRound).passed, false, "a revision must ask for a later round");
    const unanswered = clone(passing.revision);
    unanswered.session.rounds[1].status = "cancelled";
    assert.equal(verifySessionEvidence(plan, unanswered).passed, false, "round 2 must reach a decision");
    // A round 2 that only exists on paper is caught by the round number itself.
    const mislabelled = clone(passing.revision);
    mislabelled.session.rounds[1].round = 1;
    assert.equal(verifySessionEvidence(plan, mislabelled).passed, false);
  });

  it("SMOKE-001: the aggregate cannot pass on a missing session, and never claims an unproven behaviour", () => {
    const entries = SESSION_MODES.map((mode) => ({
      plan: planFor(mode),
      evidence: mode === HAPPY_SESSION
        ? { status: "passed", steps: [{ step: "complete" }], errors: {}, assertions: { realTty: true, imageRendered: true }, session: { result: { status: "completed", decision: "approve", round: 1, answers: [] }, rounds: [{ status: "completed", decision: "approve", round: 1, answers: [] }] } }
        : passing[mode],
    }));
    const all = aggregateSessionEvidence(entries);
    assert.equal(all.status, "passed");
    assert.deepEqual([...all.missingSessions], []);
    assert.deepEqual([...all.unprovenBehaviours], []);
    assert.deepEqual(Object.keys(all.assertions).sort(), ["imageRendered", "note", "realTty", "reject", "revision", "cancel"].sort());
    // A dropped session is a failure, not an omission.
    const withoutCancel = aggregateSessionEvidence(entries.filter((entry) => entry.plan.mode !== "cancel"));
    assert.equal(withoutCancel.status, "failed");
    assert.deepEqual([...withoutCancel.missingSessions], ["cancel"]);
    assert.equal(withoutCancel.assertions.cancel, undefined, "a session that never ran cannot be true");
    // A session that ran and failed reports false rather than disappearing.
    const failingReject = entries.map((entry) => (entry.plan.mode === "reject"
      ? { ...entry, evidence: evidenceFor([{ step: "reject", endedBy: "the Reject review row" }], [{ status: "completed", decision: "approve", round: 1 }]) }
      : entry));
    const aggregated = aggregateSessionEvidence(failingReject);
    assert.equal(aggregated.status, "failed");
    assert.equal(aggregated.assertions.reject, false);
    assert.deepEqual([...aggregated.unprovenBehaviours], ["reject"]);
    // Every step in the published record names the session that produced it.
    for (const step of all.steps) assert.ok(SESSION_MODES.includes(step.session), `${step.session} is not a session`);
    for (const mode of BEHAVIOUR_SESSIONS) {
      assert.ok(all.steps.some((step) => step.session === mode && step.step === mode), `${mode} is missing from the record`);
    }
  });

  it("SMOKE-001: the driver and the gate both run the whole list, and a happy-path regression fails its session", async () => {
    const driver = await readFile(new URL("../scripts/benchmark/live-driver.mjs", import.meta.url), "utf8");
    const gate = await readFile(new URL("../scripts/benchmark/smoke-live.mjs", import.meta.url), "utf8");
    assert.match(driver, /sessionPlan\(session, \{ imagePath \}\)/, "the driver must take its session from the shared plan");
    assert.match(driver, /verifySessionEvidence\(plan, evidence\)/, "the driver must judge itself with the shared check");
    assert.match(gate, /for \(const mode of sessions\)/, "the gate must run every session, not a fixed one");
    assert.match(gate, /aggregateSessionEvidence\(entries\)/, "the gate must publish the aggregate");
    for (const mode of BEHAVIOUR_SESSIONS) {
      assert.ok(driver.includes(`record("${mode}"`), `the driver must record a ${mode} step`);
    }
    assert.ok(gate.includes("`--session=${mode}`"), "the gate must pass the session to the driver, not a fixed one");
    // The happy path is not weakened: a false assertion fails the session, and
    // the eleven names are still the ones the smoke publishes.
    const happyPlan = planFor(HAPPY_SESSION);
    const happyEvidence = {
      status: "passed", steps: [{ step: "complete" }], errors: {}, assertions: { realTty: true, collapseReopen: false },
      session: { result: { status: "completed", decision: "approve", round: 1, answers: [] }, rounds: [{ status: "completed", decision: "approve", round: 1, answers: [] }] },
    };
    const verified = verifySessionEvidence(happyPlan, happyEvidence);
    assert.equal(verified.passed, false);
    assert.ok(verified.reasons.some((reason) => /collapseReopen/.test(reason)));
    const record = JSON.parse(await readFile(new URL("../.pi/benchmark/live-smoke.json", import.meta.url), "utf8"));
    const named = ["note", "revision", "reject", "cancel"];
    const recorded = new Set(record.steps.map((step) => step.step));
    for (const mode of named) assert.ok(recorded.has(mode), `the published record has no ${mode} step`);
    for (const mode of named) assert.equal(record.assertions[mode], true, `the published record has no true ${mode} assertion`);
    for (const name of ["realTty", "realExtension", "titleAndPromptOnScreen", "imageRendered", "keyboardControls", "stageAdvance", "collapseReopen", "finalReview", "externalEditor", "completedWithAnswer", "persistence"]) {
      assert.equal(record.assertions[name], true, `the eleven original assertions must stay true (${name})`);
    }
    assert.deepEqual(record.missingSessions, []);
    assert.equal(record.pty.usedPseudoTerminal, true);
    for (const mode of SESSION_MODES) assert.equal(record.pty.exitCodes[mode], 0, `${mode} must exit clean`);
  });
});

/**
 * The mockup font has to fit the cell it is drawn in.
 *
 * Every other assertion in this file looks at the mockup the way a person does
 * - is the layout right, are the rows there, does it parse. None of them looked
 * at the *pixels*, and so 280 tests passed while every label in every drawn
 * mockup was clipped: the glyph is five columns wide, drawn at a two-pixel
 * pitch, which is ten pixels in an eight-pixel cell. Each letter overlapped the
 * next by two pixels and lost its right-hand side.
 *
 * This one measures the ink. It is the only kind of assertion that could have
 * caught that, and it is cheap.
 */
describe("the mockup font fits its cell", () => {
  /** Decode a canvas to RGB rows. */
  const pixels = async (label) => {
    const { renderMockupCanvas, encodeCanvasPng, CELL_WIDTH } = await import("../src/mockup-renderer.ts");
    const { inflateSync } = await import("node:zlib");
    const png = encodeCanvasPng(renderMockupCanvas(
      { layout: "list", title: "", rows: [{ label, value: 1 }] },
      { widthCells: 14, heightCells: 8 },
    ));
    let offset = 8;
    let idat = Buffer.alloc(0);
    let width = 0;
    let height = 0;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      const kind = png.subarray(offset + 4, offset + 8).toString("latin1");
      if (kind === "IHDR") { width = png.readUInt32BE(offset + 8); height = png.readUInt32BE(offset + 12); }
      if (kind === "IDAT") idat = Buffer.concat([idat, png.subarray(offset + 8, offset + 8 + length)]);
      offset += 12 + length;
    }
    const raw = inflateSync(idat);
    const stride = width * 3;
    const at = (x, y) => {
      const start = y * (stride + 1) + 1 + x * 3;
      return raw.subarray(start, start + 3);
    };
    return { at, width, height, cellWidth: CELL_WIDTH };
  };

  /**
   * The columns a label put ink in, found by differencing two renders.
   *
   * Guessing which row the label landed on was wrong twice - the canvas draws a
   * title, a row count and separators, and any of them reads as text. Rendering
   * "M" and "MM" and taking the columns that differ gives the label ink and
   * nothing else, with no assumption about the chrome at all.
   */
  const labelInk = async (one, two) => {
    const a = await pixels(one);
    const b = await pixels(two);
    const columns = [];
    for (let x = 0; x < a.width; x += 1) {
      let changed = false;
      for (let y = 0; y < a.height && !changed; y += 1) {
        if (!a.at(x, y).equals(b.at(x, y))) changed = true;
      }
      columns.push(changed);
    }
    return { columns, cellWidth: a.cellWidth };
  };

  const runs = (columns) => {
    const found = [];
    let start = -1;
    for (let x = 0; x < columns.length; x += 1) {
      if (columns[x] && start < 0) start = x;
      if (!columns[x] && start >= 0) { found.push([start, x - 1]); start = -1; }
    }
    if (start >= 0) found.push([start, columns.length - 1]);
    return found;
  };

  it("draws letters as separate shapes, each inside its own cell", async () => {
    // The label area truncates to about four cells, so the widest sample that
    // still renders every letter is four of them. What matters is the shape of
    // the ink: with the font at a two-pixel pitch a letter is ten pixels wide in
    // an eight-pixel cell, so consecutive letters merge into one blob and lose
    // their right-hand sides.
    const { columns, cellWidth } = await labelInk("", "MMMM");
    const letters = runs(columns);
    assert.ok(letters.length >= 3, `the letters are drawn as separate shapes (got ${letters.length} runs for four letters)`);
    for (let index = 1; index < letters.length; index += 1) {
      const gap = letters[index][0] - letters[index - 1][1] - 1;
      assert.ok(gap >= 1, `letters ${index} and ${index + 1} are ${gap}px apart; 0 means they overlap`);
    }
    const widest = Math.max(...letters.map(([from, to]) => to - from + 1));
    assert.ok(widest <= cellWidth, `the widest letter is ${widest}px, and a cell is ${cellWidth}px`);
  });
});

/**
 * The character-drawn mockup's geometry, measured rather than eyeballed.
 *
 * The first version came out with rules two cells narrower than the rows they
 * framed, a height budget one row short of what it emitted, a degenerate frame
 * for a NaN width, and code-point counting that overflowed on a CJK label. None
 * of those is visible in a snapshot of *one* frame, so they are pinned by
 * measuring the ink: every line the same display width, never more lines than
 * the budget, and a bounded frame for hostile geometry.
 */
describe("the text mockup's frame is a frame", () => {
  /** Display columns, counting the wide ranges twice. */
  const columns = (line) => {
    let total = 0;
    for (const character of line) {
      const code = character.codePointAt(0);
      total += ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xff00 && code <= 0xff60)) ? 2 : 1;
    }
    return total;
  };

  const sample = { layout: "airy", title: "TRANSIT AIRY", rows: [
    { label: "On time", value: 0.98, status: "ok" }, { label: "Active", value: 0.71, status: "warn" },
  ] };

  it("draws every line the same width, at every width", async () => {
    const { renderMockupText } = await import("../src/mockup-text.ts");
    for (const width of [28, 40, 54, 72, 100]) {
      const lines = renderMockupText(sample, { width, height: 9 });
      const widths = [...new Set(lines.map(columns))];
      assert.equal(widths.length, 1, `at ${width} columns every line is the same width: ${JSON.stringify(widths)}`);
    }
  });

  it("never emits more lines than it was given", async () => {
    const { renderMockupText } = await import("../src/mockup-text.ts");
    const many = { ...sample, rows: Array.from({ length: 20 }, (_, index) => ({ label: `Row ${index + 1}`, value: 0.5 })) };
    for (const height of [5, 6, 8, 9, 12, 20, 40]) {
      const lines = renderMockupText(many, { width: 40, height });
      assert.ok(lines.length <= height, `budget ${height}: emitted ${lines.length}`);
    }
  });

  it("draws a bounded frame for geometry that is not a number", async () => {
    const { renderMockupText } = await import("../src/mockup-text.ts");
    for (const [width, height] of [[NaN, NaN], [-5, -5], [1e9, 1e9], [0, 0], [undefined, undefined]]) {
      const lines = renderMockupText(sample, { width, height });
      const widths = [...new Set(lines.map(columns))];
      assert.ok(lines.length >= 4, `width=${width}: something like a frame, ${lines.length} lines`);
      assert.equal(widths.length, 1, `width=${width}: and one consistent width, ${JSON.stringify(widths)}`);
      assert.ok(widths[0] >= 28 && widths[0] <= 72, `width=${width}: inside the documented 28..72, got ${widths[0]}`);
    }
  });

  it("counts columns rather than code points, so a CJK label cannot overflow", async () => {
    const { renderMockupText } = await import("../src/mockup-text.ts");
    const lines = renderMockupText(
      { ...sample, title: "日本語のタイトル", rows: [{ label: "運行状況", value: 0.9 }] },
      { width: 40, height: 8 },
    );
    const widths = [...new Set(lines.map(columns))];
    assert.equal(widths.length, 1, `a CJK title and label keep the frame square: ${JSON.stringify(widths)}`);
    assert.ok(widths[0] <= 40, "and do not overflow the width they were given");
  });
});

/**
 * A hostile PNG is a bounded error, not a 4.8 GB allocation.
 *
 * A PNG declares its own dimensions and those dimensions decide the size of the
 * decode buffer, so a 62-byte file claiming 40000x40000 is enough to ask for
 * gigabytes. The chunk loop had the same problem in miniature: a declared chunk
 * length was truncated silently rather than reported, which turned a short IHDR
 * into undefined fields and an over-long one into a loop that ended with no
 * error at all.
 */
describe("a hostile PNG is refused, not attempted", () => {
  /** A syntactically valid PNG whose IHDR claims whatever we like. */
  const claiming = async (width, height, colorType = 2) => {
    const { deflateSync } = await import("node:zlib");
    const table = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    const crc = (buffer) => {
      let c = 0xffffffff;
      for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, body) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(body.length);
      const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
      const check = Buffer.alloc(4);
      check.writeUInt32BE(crc(typed));
      return Buffer.concat([length, typed, check]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = colorType;
    const idat = deflateSync(Buffer.alloc(Math.max(1, Math.min(64, width * height * 3))));
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0)),
    ]);
  };

  it("refuses dimensions that would allocate gigabytes", async () => {
    const { decodePng } = await import("../src/png.ts");
    const huge = await claiming(40000, 40000);
    const zero = await claiming(0, 100);
    assert.throws(() => decodePng(huge), /40000x40000|the limit is/);
    assert.throws(() => decodePng(zero), /not positive/);
    // The sanity check uses the project's own encoder, so it is a real PNG with
    // real scanlines rather than a header wrapped around some compressed zeroes.
    const { Canvas, encodeCanvasPng } = await import("../src/mockup-renderer.ts");
    const canvas = new Canvas(64, 64, "white");
    canvas.text("ok", 1, 1, 8, [0, 0, 0]);
    const decoded = decodePng(encodeCanvasPng(canvas));
    assert.equal(decoded.width * decoded.height * 3, decoded.data.length, "an ordinary PNG still decodes, with its pixels");
  });

  it("reports a chunk that lies about its length", async () => {
    const { decodePng } = await import("../src/png.ts");
    const png = await claiming(4, 4);
    const at = png.indexOf(Buffer.from("IDAT", "ascii"));
    png.writeUInt32BE(0xffff, at - 4);
    assert.throws(() => decodePng(png), /claims 65535 bytes|only/);
  });
});

/**
 * A review cannot read the rest of your disk.
 *
 * A review is a JSON file the model writes, so an `image.path` in it is a path
 * the model chose and the loader resolved with nothing in between: `../../.ssh/
 * id_rsa` and `/etc/shadow` both reached `readFile`, were base64-encoded, and
 * were drawn into the panel. The size cap that went in beside this stops a big
 * file being read; only confinement stops the wrong one.
 */
describe("an image path stays inside the review's own directory", () => {
  it("reads what is inside and refuses what is outside, by name", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { loadImage } = await import("../src/image-loader.ts");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const root = resolve("/tmp/panel-invariants-review");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, "inside.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ));
    try {
      const load = async (path) => {
        try {
          await loadImage({ path }, root);
          return "read";
        } catch (error) {
          return error.message;
        }
      };
      assert.equal(await load("inside.png"), "read", "a relative path inside the review's directory");
      assert.equal(await load("./inside.png"), "read", "and with an explicit ./ prefix");
      assert.equal(await load(resolve(root, "inside.png")), "read", "and as an absolute path that lands inside");
      assert.equal(await load("sub/../inside.png"), "read", "and through a directory that does not exist yet");
      for (const escape of ["../escape.png", "../../.ssh/id_rsa", "/etc/shadow"]) {
        const message = await load(escape);
        assert.match(message, /outside the review's directory/, `${escape} is refused, and says so`);
        assert.match(message, /Only files under/, `${escape} is told where files may come from`);
      }
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * The lexical confinement test sees the path as it was *spelled*; `readFile`
 * then follows a symlink. A link inside the review's own directory pointing out
 * of it therefore read the target whole and base64-encoded it into the panel -
 * which is precisely the unrestricted read primitive the confinement exists to
 * remove, reachable through a path the guard calls inside.
 */
describe("a symlink cannot carry an image path out of the review's directory", () => {
  it("refuses a link whose target resolves outside, and still reads a real file inside", async () => {
    const { mkdirSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { loadImage } = await import("../src/image-loader.ts");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const root = resolve("/tmp/panel-invariants-symlink/review");
    const outside = resolve("/tmp/panel-invariants-symlink");
    rmSync(outside, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(resolve(outside, "secret.png"), png);
    writeFileSync(resolve(root, "inside.png"), png);
    symlinkSync(resolve(outside, "secret.png"), resolve(root, "link.png"));
    try {
      const load = async (path) => {
        try {
          const loaded = await loadImage({ path }, root);
          return loaded.base64.length > 0 ? "read" : "empty";
        } catch (error) {
          return error.message;
        }
      };
      assert.equal(await load("inside.png"), "read", "a real file inside the review's directory still reads");
      const message = await load("link.png");
      assert.match(message, /outside the review's directory/, "a symlink out of the directory is refused");
      assert.match(message, /Only files under/, "and it names the directory files may come from");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * `fetch` follows redirects by default, so the host guard ran on the URL the
 * model wrote and never on the one that answered. A perfectly permitted public
 * address could therefore 302 into the loopback interface or a cloud metadata
 * endpoint - and the provenance recorded for the panel was the URL asked for
 * rather than the host that served the bytes.
 */
describe("a redirect is not a way around the host guard", () => {
  it("refuses a hop that leaves the public network, and follows one that stays", async () => {
    const http = await import("node:http");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { loadImage } = await import("../src/image-loader.ts");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const hits = [];
    const secret = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { "content-type": "image/png" }); res.end(png); });
    await new Promise((resolve_) => secret.listen(0, "127.0.0.1", resolve_));
    const secretPort = secret.address().port;
    const bouncer = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://localhost:${secretPort}/latest/meta-data/` });
    });
    await new Promise((resolve_) => bouncer.listen(0, "127.0.0.1", resolve_));
    const bouncerPort = bouncer.address().port;
    // A public-looking authority that resolves to the loopback, so the only
    // thing that can stop the request is the guard on the redirect target.
    const redirector = http.createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${bouncerPort}/x.png` }); });
    await new Promise((resolve_) => redirector.listen(0, "127.0.0.1", resolve_));
    const redirectorPort = redirector.address().port;
    try {
      let message = "";
      try {
        await loadImage({ url: `http://127.0.0.1:${redirectorPort}/x.png` }, process.cwd());
      } catch (error) {
        message = error.message;
      }
      assert.match(message, /points at this machine/, "the first hop is refused before it is even made");
      assert.deepEqual(hits, [], "and the redirect target is never contacted");

      // The host spellings the URL parser produces rather than the ones a
      // person would type. Both address 127.0.0.1.
      for (const spelling of [`http://localhost.:${secretPort}/x.png`, `http://[::ffff:127.0.0.1]:${secretPort}/x.png`]) {
        message = "";
        try {
          await loadImage({ url: spelling }, process.cwd());
        } catch (error) {
          message = error.message;
        }
        assert.match(message, /points at this machine/, `${spelling} must not reach the loopback interface`);
      }
      assert.deepEqual(hits, [], "and none of them was ever fetched");
    } finally {
      for (const server of [secret, bouncer, redirector]) await new Promise((done) => server.close(done));
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * The size limit used to be applied after `response.arrayBuffer()`, which is a
 * check that has already lost: a chunked response with no `content-length`
 * skips the header guard and is buffered whole first. 64 MB was held in memory
 * before the refusal arrived.
 *
 * Tested directly rather than through `loadImage`, because the host guard
 * correctly refuses every address this machine can serve an image from - which
 * is the right behaviour and also makes the streaming path unreachable from the
 * outside.
 */
describe("a reference body is abandoned the moment it passes the limit", () => {
  it("refuses a chunked body with no content-length, without holding it whole", async () => {
    const { readCappedBody } = await import("../src/image-loader.ts");
    const CHUNK = Buffer.alloc(1024 * 1024, 0x41);
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          let sent = 0;
          const pump = () => {
            while (sent < 64) {
              controller.enqueue(CHUNK);
              sent += 1;
            }
            controller.close();
          };
          pump();
        },
      }),
      { headers: { "content-type": "image/png" } },
    );
    assert.equal(streamed.headers.get("content-length"), null, "the response must carry no length header, or the test proves nothing");
    let message = "";
    try {
      await readCappedBody(streamed, 8 * 1024 * 1024, (text) => new Error(text));
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /more than 8388608 bytes/, `a 64 MB chunked body should be refused at 8 MB, got: ${message}`);

    const small = new Response(CHUNK.subarray(0, 16));
    assert.equal((await readCappedBody(small, 1024, (text) => new Error(text))).length, 16, "a body inside the limit still reads");
  });
});
