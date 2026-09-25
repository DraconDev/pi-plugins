import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { generateCorpus, validateCorpus } from "../scripts/benchmark/corpus.mjs";
import { assertNoCredentials, wilsonLowerBound } from "../scripts/benchmark/common.mjs";
import { verifyAggregateReport } from "../scripts/benchmark/report.mjs";
import { detectImage, promptHash } from "../scripts/benchmark/images.mjs";
import { blindLabels } from "../scripts/benchmark/compare.mjs";

function validAggregate() {
  return {
    schemaVersion: 1,
    kind: "benchmark-aggregate-report",
    corpus: { count: 1000, strata: { ordinary: 700, visual: 200, adversarial: 100 } },
    comparison: {
      deterministicAccuracy: 1,
      wilson95LowerBound: 0.99,
      gates: { accuracy: true, confidenceBound: true },
    },
    defects: [],
    images: {
      visualUplift: 0.2,
      severeFailureRate: 0,
      gates: { visualUplift: true, severeFailures: true },
    },
    liveSmoke: { status: "passed", observedAt: "2026-09-25T10:00:00Z", details: "real TTY and editor" },
    activation: {
      claimed: true,
      status: "passed",
      afterGates: true,
      gatesVerifiedAt: "2026-09-25T10:01:00Z",
      observedAt: "2026-09-25T10:02:00Z",
      details: "authorized settings verification",
    },
  };
}

describe("benchmark corpus", () => {
  it("generates exactly 1000 unique scenarios in the required strata with reproducible seed output", () => {
    const first = generateCorpus({ count: 1000, seed: 20260925 });
    const second = generateCorpus({ count: 1000, seed: 20260925 });
    assert.equal(first.count, 1000);
    assert.deepEqual(first.strata, { ordinary: 700, visual: 200, adversarial: 100 });
    assert.equal(new Set(first.scenarios.map((scenario) => scenario.id)).size, 1000);
    assert.equal(new Set(first.scenarios.map((scenario) => JSON.stringify(scenario.canonicalInput))).size, 1000);
    assert.deepEqual(first, second);
    assert.notDeepEqual(generateCorpus({ count: 1000, seed: 1 }).scenarios, first.scenarios);
    assert.equal(validateCorpus(first), true);
    for (const scenario of first.scenarios) {
      assert.ok(scenario.terminalConstraints);
      assert.ok(scenario.expected.outcome);
      assert.ok(scenario.expected.classification);
      assert.ok(scenario.visualPrompt);
    }
  });

  it("rejects count, duplicate, reserved-label, shape, and credential problems", () => {
    assert.throws(() => generateCorpus({ count: 0 }), /integer/);
    assert.throws(() => generateCorpus({ count: 1.5 }), /integer/);
    const corpus = generateCorpus({ count: 10, seed: 4 });
    assert.throws(() => validateCorpus({ ...corpus, count: corpus.count + 1 }), /count/);
    const duplicate = structuredClone(corpus);
    duplicate.scenarios[1].id = duplicate.scenarios[0].id;
    assert.throws(() => validateCorpus(duplicate), /Duplicate scenario id/);
    const reserved = structuredClone(corpus);
    const reservedQuestion = reserved.scenarios.find((scenario) => scenario.stratum === "ordinary").canonicalInput.questions[0];
    reservedQuestion.options[0].label = "Type something.";
    assert.throws(() => validateCorpus(reserved), /not a valid review|reserved/);
    const incomplete = structuredClone(corpus);
    incomplete.scenarios[0] = { id: "incomplete" };
    assert.throws(() => validateCorpus(incomplete), /must be an object|has an invalid/);
    assert.throws(() => assertNoCredentials({ nested: { apiKey: "not-a-real-key" } }), /Credential-shaped key/);
    assert.throws(() => assertNoCredentials({ note: "Bearer abcdefghijklmnop" }), /Credential-shaped value/);
  });
});

describe("benchmark scoring helpers", () => {
  it("computes the Wilson 95% lower bound", () => {
    const bound = wilsonLowerBound(8, 10);
    assert.ok(bound > 0.4 && bound < 0.6);
    assert.equal(wilsonLowerBound(0, 10), 0);
    assert.equal(wilsonLowerBound(10, 10), 0.7224672001371106);
    assert.throws(() => wilsonLowerBound(2, 1), /integer/);
  });

  it("uses stable, seeded blind A/B labels", () => {
    assert.deepEqual(blindLabels(20260925, "ordinary-0001"), blindLabels(20260925, "ordinary-0001"));
    const labels = blindLabels(20260925, "ordinary-0001");
    assert.deepEqual(Object.values(labels).sort(), ["candidate", "reference"]);
  });

  it("recognizes only supported local signatures and hashes prompts", async () => {
    const png = await readFile(new URL("./fixtures/tiny.png", import.meta.url));
    assert.equal(detectFile(png).mimeType, "image/png");
    assert.match(promptHash("same prompt"), /^[a-f0-9]{64}$/);
    assert.throws(() => detectImage(Buffer.from("not an image")), /signature/);
  });
});

function detectFile(bytes) {
  return detectImage(bytes);
}

describe("aggregate report verifier", () => {
  it("accepts a fully evidenced report and rejects every missing gate or premature activation claim", () => {
    assert.deepEqual(verifyAggregateReport(validAggregate()), { verified: true, activationClaim: "evidenced" });
    const missingCounts = validAggregate();
    delete missingCounts.corpus.strata.visual;
    assert.throws(() => verifyAggregateReport(missingCounts), /stratum/);
    const unresolved = validAggregate();
    unresolved.defects = [{ id: "BUG-1", severity: "P0", status: "open" }];
    assert.throws(() => verifyAggregateReport(unresolved), /Unresolved critical/);
    const noSmoke = validAggregate();
    delete noSmoke.liveSmoke;
    assert.throws(() => verifyAggregateReport(noSmoke), /evidence/);
    const premature = validAggregate();
    premature.activation.observedAt = "2026-09-25T10:00:59Z";
    assert.throws(() => verifyAggregateReport(premature), /after all gates/);
    const noActivation = validAggregate();
    noActivation.activation.claimed = false;
    assert.throws(() => verifyAggregateReport(noActivation), /Activation evidence/);
  });
});
