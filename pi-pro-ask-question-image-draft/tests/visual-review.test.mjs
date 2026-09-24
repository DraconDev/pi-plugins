import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  MAX_IMAGE_DATA_LENGTH,
  ReviewParamsSchema,
  normalizeReview,
  validateReview,
} from "../src/schema.ts";
import {
  findReviewState,
  isReviewState,
  makeReviewResult,
  makeReviewState,
  mergeAnswers,
  unresolvedStages,
} from "../src/state.ts";
import { buildResponse, errorResponse } from "../src/envelope.ts";
import { fallbackText, makeFallbackResult, runDialogReview } from "../src/fallback.ts";
import { loadImage } from "../src/image-loader.ts";

const baseReview = () => normalizeReview({
  reviewId: "review-test",
  title: "Visual test",
  stages: [{
    id: "layout",
    header: "Layout",
    prompt: "Choose a layout",
    options: [
      { id: "grid", label: "Grid", value: "grid" },
      { id: "stack", label: "Stack", value: "stack" },
    ],
  }],
});

function reviewWith(stages, extra = {}) {
  return normalizeReview({ reviewId: "review-test", stages, ...extra });
}

function answerFor(review, stageId, optionId) {
  const stageIndex = review.stages.findIndex((stage) => stage.id === stageId);
  const stage = review.stages[stageIndex];
  return {
    stageId,
    stageIndex,
    kind: stage.multiSelect ? "multi" : "option",
    optionIds: [optionId],
    optionLabels: [stage.options.find((option) => option.id === optionId).label],
    optionValues: [stage.options.find((option) => option.id === optionId).value],
    answer: stage.options.find((option) => option.id === optionId).label,
  };
}

describe("schema and legacy compatibility", () => {
  it("normalizes staged reviews and assigns stable ids", () => {
    const review = baseReview();
    assert.equal(review.reviewId, "review-test");
    assert.equal(review.stages[0].id, "layout");
    assert.deepEqual(review.stages[0].options.map((option) => option.id), ["grid", "stack"]);
    assert.equal(review.stages[0].required, true);
    assert.equal(review.stages[0].allowOther, true);
  });

  it("accepts the legacy questions[] shape", () => {
    const review = normalizeReview({
      questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
    });
    assert.equal(review.stages.length, 1);
    assert.equal(review.stages[0].id, "question-1");
    assert.equal(review.stages[0].allowRevision, false);
  });

  it("rejects malformed images and mixed stage shapes with controlled errors", () => {
    assert.throws(() => normalizeReview({ stages: [{ header: "x", prompt: "x", options: [{ label: "A", image: { mimeType: "image/png" } }, { label: "B" }] }] }), /image needs path|url|dataUri|mimeType|alt/);
    assert.throws(() => normalizeReview({ stages: [{ header: "x", prompt: "x", options: [{ label: "A" }, { label: "B" }] }], questions: [{ question: "x", options: [{ label: "A" }, { label: "B" }] }] }), /either stages or legacy questions/);
    assert.equal(MAX_IMAGE_DATA_LENGTH > 0, true);
    assert.equal(ReviewParamsSchema.type, "object");
    validateReview(baseReview());
  });
});

describe("strict staged state gate", () => {
  it("does not approve while a required stage is unresolved", () => {
    const review = baseReview();
    assert.throws(() => makeReviewResult(review, "approve", []), /every stage/);
    assert.equal(unresolvedStages(review, []).length, 1);
  });

  it("allows an optional stage to be explicitly skipped without allowing required skips", () => {
    const review = reviewWith([
      { id: "required", header: "Required", prompt: "Required", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "optional", header: "Optional", prompt: "Optional", required: false, options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
    ]);
    const answer = answerFor(review, "required", "a");
    const result = makeReviewResult(review, "approve", [answer], undefined, ["optional"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.skippedStageIds, ["optional"]);
    assert.throws(() => makeReviewResult(review, "approve", [], undefined, ["required"]), /Required stage cannot be skipped/);
  });

  it("rejects malformed answers instead of accepting an option id", () => {
    const review = baseReview();
    assert.throws(() => makeReviewResult(review, "approve", [{ stageId: "layout", stageIndex: 0, kind: "option", optionIds: ["not-real"], answer: "Grid" }]), /not valid/);
    assert.throws(() => makeReviewResult(review, "approve", [{ stageId: "missing", stageIndex: 0, kind: "option", optionIds: ["grid"], answer: "Grid" }]), /unknown stage/);
  });

  it("round-trips persisted state and carries valid answers across reordered stages", () => {
    const review = reviewWith([
      { id: "one", header: "One", prompt: "One", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "two", header: "Two", prompt: "Two", options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
    ]);
    const first = answerFor(review, "two", "d");
    const merged = mergeAnswers([first], [...review.stages].reverse());
    assert.equal(merged.get("two")?.stageIndex, 0);
    const state = makeReviewState(review, [first, answerFor(review, "one", "a")], "completed");
    assert.equal(isReviewState(state), true);
    assert.equal(findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], review.reviewId)?.answers.find((answer) => answer.stageId === "two")?.stageId, "two");
  });

  it("requires a later requested round for revisions", () => {
    const review = baseReview();
    const answer = answerFor(review, "layout", "grid");
    assert.throws(() => makeReviewResult(review, "revision", [answer], { stageId: "layout", stageIndex: 0, feedback: "Try again", requestedRound: 1 }), /later round/);
    const result = makeReviewResult(review, "revision", [answer], { stageId: "layout", stageIndex: 0, feedback: "Try again", requestedRound: 2 });
    assert.equal(result.status, "revision");
  });
});

describe("envelopes and fallback", () => {
  it("builds explicit outcome envelopes", () => {
    const review = baseReview();
    const answer = answerFor(review, "layout", "grid");
    const response = buildResponse(makeReviewResult(review, "approve", [answer]), review);
    assert.match(response.content[0].text, /User has answered/);
    assert.match(errorResponse("bad").content[0].text, /could not start/);
    assert.equal(makeFallbackResult(review, "no_ui").decision, "fallback");
    assert.match(fallbackText(review, "no_ui"), /not a decline/);
  });

  it("runs a strict sequential dialog path and supports cancel/reject", async () => {
    const review = baseReview();
    const selects = ["Grid", "Approve review"];
    const ctx = {
      signal: new AbortController().signal,
      ui: {
        select: async () => selects.shift(),
        confirm: async () => true,
        input: async () => undefined,
      },
    };
    const result = await runDialogReview(ctx, review);
    assert.equal(result.status, "completed");
    assert.equal(result.answers[0].optionIds[0], "grid");

    const cancelCtx = { ...ctx, ui: { ...ctx.ui, select: async () => undefined, confirm: async () => true, input: async () => undefined } };
    assert.equal((await runDialogReview(cancelCtx, review)).status, "cancelled");
  });
});

describe("image references", () => {
  it("loads a supplied data URI and never generates an image", async () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const loaded = await loadImage({ dataUri: `data:image/png;base64,${png}` }, process.cwd());
    assert.equal(loaded.mimeType, "image/png");
    assert.equal(loaded.base64, png);
  });

  it("keeps the checked-in fixture readable", async () => {
    const fixture = await readFile(new URL("./fixtures/tiny.png", import.meta.url), "base64");
    const review = normalizeReview({ reviewId: "image", stages: [{ header: "Image", prompt: "Pick", options: [{ label: "A", image: { path: new URL("./fixtures/tiny.png", import.meta.url).pathname } }, { label: "B" }] }] });
    assert.equal((await loadImage(review.stages[0].options[0].image, process.cwd())).mimeType, "image/png");
    assert.ok(fixture.length > 0);
  });
});
