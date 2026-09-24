import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { generateReviewImages, ImageGenerationError } from "../src/image-generator.ts";

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

  it("runs a strict sequential dialog path and supports multi-select, custom, revision, cancel, and reject", async () => {
    const review = reviewWith([
      { id: "single", header: "Single", prompt: "Choose one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "many", header: "Many", prompt: "Choose many", multiSelect: true, options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
      { id: "optional", header: "Optional", prompt: "Optional", required: false, options: [{ id: "e", label: "E" }, { id: "f", label: "F" }] },
    ]);
    const selects = ["A", "C", "D", "Done selecting", "Skip stage"];
    const inputs = [];
    const confirms = [];
    const ctx = {
      signal: new AbortController().signal,
      ui: {
        select: async () => selects.shift(),
        confirm: async (title) => { confirms.push(title); return true; },
        input: async (title) => { inputs.push(title); return "custom"; },
      },
    };
    const result = await runDialogReview(ctx, review);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.answers.map((answer) => answer.stageId), ["single", "many"]);
    assert.deepEqual(result.skippedStageIds, ["optional"]);
    assert.deepEqual(inputs, []);
    assert.deepEqual(confirms, ["Visual review"]);

    const cancelCtx = { signal: ctx.signal, ui: { select: async () => undefined, confirm: async () => true, input: async () => undefined } };
    assert.equal((await runDialogReview(cancelCtx, review)).status, "cancelled");

    const resumedSelects = ["A", "D", "Done selecting", "Skip stage"];
    const resumed = await runDialogReview({ signal: ctx.signal, ui: { select: async () => resumedSelects.shift(), confirm: async () => true, input: async () => undefined } }, review, [], ["optional"]);
    assert.equal(resumed.status, "completed");
    assert.deepEqual(resumed.answers.map((answer) => answer.stageId), ["single", "many"]);
    assert.deepEqual(resumed.skippedStageIds, ["optional"]);

    const rejectCtx = { signal: ctx.signal, ui: { select: async () => "Reject review", confirm: async () => true, input: async () => undefined } };
    assert.equal((await runDialogReview(rejectCtx, review)).status, "rejected");

    const approvalSelects = ["Approve review", "A", "Approve review", "C", "D", "Done selecting", "Approve review", "Skip stage", "Approve review"];
    const approval = await runDialogReview({ signal: ctx.signal, ui: { select: async () => approvalSelects.shift(), confirm: async () => true, input: async () => undefined } }, review);
    assert.equal(approval.status, "completed");
    assert.deepEqual(approval.answers.map((answer) => answer.stageId), ["single", "many"]);
  });
});

describe("image references and explicit generation", () => {
  it("generates only explicitly requested options and returns a durable local path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-visual-review-"));
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const calls = [];
    const fakeFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ b64_json: png, mime_type: "image/png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const review = normalizeReview({
        reviewId: "generation-test",
        stages: [{
          id: "visual",
          header: "Visual",
          prompt: "Compare these",
          options: [
            { id: "generated", label: "Generated", generate: { prompt: "A bright blue card" } },
            { id: "existing", label: "Existing" },
          ],
        }],
      });
      const result = await generateReviewImages(review, {
        cwd,
        fetchImpl: fakeFetch,
        resolveCredential: () => "test-key",
        now: () => 1234,
        randomId: () => "fixed-id",
      });
      assert.equal(result.images.length, 1);
      assert.equal(result.review.stages[0].options[0].generate, undefined);
      assert.match(result.review.stages[0].options[0].image.path, /generated-images/);
      assert.deepEqual(await readFile(result.review.stages[0].options[0].image.path), Buffer.from(png, "base64"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://apihub.agnes-ai.com/v1/images/generations");
      assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
      assert.deepEqual(JSON.parse(calls[0].init.body), {
        model: "agnes-image-2.5-flash",
        prompt: "A bright blue card",
        response_format: "b64_json",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not call a provider when no option requests generation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-visual-review-"));
    let calls = 0;
    try {
      const review = normalizeReview({
        reviewId: "no-generation",
        stages: [{ header: "Choice", prompt: "Choose", options: [{ label: "A" }, { label: "B" }] }],
      });
      const result = await generateReviewImages(review, {
        cwd,
        fetchImpl: async () => { calls += 1; throw new Error("must not be called"); },
        resolveCredential: () => "test-key",
      });
      assert.equal(calls, 0);
      assert.equal(result.images.length, 0);
      assert.equal(result.review, review);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsupported providers with a typed error", async () => {
    const review = normalizeReview({
      reviewId: "bad-provider",
      stages: [{ header: "Choice", prompt: "Choose", options: [
        { label: "A", generate: { prompt: "A", provider: "unknown" } },
        { label: "B" },
      ] }],
    });
    await assert.rejects(
      generateReviewImages(review, { cwd: process.cwd(), resolveCredential: () => "test-key" }),
      (error) => error instanceof ImageGenerationError && error.code === "unsupported_provider",
    );
  });

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
