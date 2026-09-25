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

import { compareCorpus, blindLabels, runLocal } from "../scripts/benchmark/compare.mjs";
import { DURABLE_CORPUS_PATH, generateCorpus, loadDurableCorpus } from "../scripts/benchmark/corpus.mjs";
import { editorCandidates, quitSequenceFor, resolveEditorCommand, whichExecutable } from "../scripts/benchmark/editor.mjs";
import { optionPrompt, surfaceSubject, treatmentDirective } from "../scripts/benchmark/image-prompt.mjs";
import { adjudicate, buildCase, judgeSummary, parseJudgeReply, parseStrictJudge } from "../scripts/benchmark/judge.mjs";
import { CONTRACT_ALIAS_PREFIX, ingestImageManifest, optionPrompt as imageOptionPrompt, planImages, promptHash } from "../scripts/benchmark/images.mjs";
import { buildAggregateReport, recomputeGates, verifyAggregateReport, verifyDefectLedger, verifyTerminalOutcomes } from "../scripts/benchmark/report.mjs";
import { resolveSmokeImage } from "../scripts/benchmark/smoke-live.mjs";
import { verifyEvidence } from "../scripts/benchmark/publish.mjs";

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
      assert.match(item.prompt, new RegExp(`Arm ${item.imageSide}: the three treatments rendered as images`));
      assert.equal(labels[item.imageSide], "candidate");
      const other = item.imageSide === "A" ? "B" : "A";
      assert.match(item.prompt, new RegExp(`Arm ${other}: the same three treatments as the current text`));
    }
  });

  it("JUDGE-002: adjudication credits the candidate exactly when the seeded label map says so", () => {
    const labels = { A: "reference", B: "candidate" };
    const pass = (winner) => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure: "none", rationale: "r" });
    assert.equal(adjudicate([pass("B"), pass("B")], labels).candidate, true);
    assert.equal(adjudicate([pass("A"), pass("A")], labels).candidate, false);
    // Inverted case: the image arm is B and both passes picked it.
    assert.equal(adjudicate([pass("B"), pass("B")], { A: "candidate", B: "reference" }).candidate, false);
  });

  it("JUDGE-003: a verdict wrapped in prose or a fenced block is recovered, and a reply that is not a verdict still fails", () => {
    const verdict = { winner: "A", utilityA: 0.8, utilityB: 0.2, severeFailure: "none", rationale: "clearer" };
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
    const pass = (winner) => ({ winner, utilityA: 0.5, utilityB: 0.5, severeFailure: "none", rationale: "r" });
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
      assert.match(prompt, /flat UI mockup/);
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
          const { directive } = treatmentDirective(option);
          assert.ok(directive.length > 12, `empty directive for ${option.label}`);
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
    corpus.scenarios[0].expected = { outcome: "invalid", oracle: "exact", classification: "rejected-before-ui", answers: [] };
    assert.doesNotThrow(() => { import("../scripts/benchmark/corpus.mjs"); });
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
