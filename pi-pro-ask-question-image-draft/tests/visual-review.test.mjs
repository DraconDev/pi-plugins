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

  it("normalizes line terminators across all user-facing text fields", () => {
    const review = normalizeReview({
      title: "Visual\r\nreview",
      notes: "Global\r\nnote",
      stages: [{
        id: "layout",
        header: "Lay\rout",
        prompt: "Choose\r\na layout",
        description: "Context\r\nhere",
        imagePrompt: "Prompt\r\nhere",
        options: [
          { id: "grid", label: "Gr\r\nid", description: "Dense\r\nlayout", preview: "# A\r\nB" },
          { id: "stack", label: "Stack", value: "st\r\nack" },
        ],
      }],
    });
    assert.equal(review.title, "Visual\nreview");
    assert.equal(review.notes, "Global\nnote");
    assert.equal(review.stages[0].header, "Layout");
    assert.equal(review.stages[0].prompt, "Choose\na layout");
    assert.equal(review.stages[0].description, "Context\nhere");
    assert.equal(review.stages[0].imagePrompt, "Prompt\nhere");
    assert.equal(review.stages[0].options[0].label, "Gr\nid");
    assert.equal(review.stages[0].options[0].description, "Dense\nlayout");
    assert.equal(review.stages[0].options[0].preview, "# A\nB");
    assert.equal(review.stages[0].options[1].value, "st\nack");
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

  it("persists generated image references without making them answers", () => {
    const review = normalizeReview({
      reviewId: "generated-state",
      stages: [{
        id: "layout",
        header: "Layout",
        prompt: "Choose a layout",
        options: [
          { id: "grid", label: "Grid", image: { path: "/tmp/generated.png" } },
          { id: "stack", label: "Stack" },
        ],
      }],
    });
    const answer = answerFor(review, "layout", "grid");
    const state = makeReviewState(review, [answer], "completed", [], [{
      stageId: "layout",
      optionId: "grid",
      path: "/tmp/generated.png",
      mimeType: "image/png",
      provider: "agnes",
      model: "agnes-image-2.5-flash",
      byteCount: 123,
      generated: true,
    }]);
    assert.equal(isReviewState(state), true);
    assert.equal(state.generatedImages?.[0]?.generated, true);
    assert.equal(state.answers[0].stageId, "layout");
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
  it("builds explicit outcome envelopes and preserves the compatibility details surface", () => {
    const review = baseReview();
    const answer = { ...answerFor(review, "layout", "grid"), notes: "Keep the spacing." };
    const result = makeReviewResult(review, "approve", [answer], undefined, [], "Ship it.");
    const response = buildResponse(result, review);
    assert.match(response.content[0].text, /User has answered/);
    assert.match(response.content[0].text, /Keep the spacing/);
    assert.match(response.content[0].text, /Ship it/);
    assert.equal(response.details.answers[0]?.questionIndex, 0);
    assert.equal(response.details.answers[0]?.answer, "Grid");
    assert.equal(response.details.answers[0]?.notes, "Keep the spacing.");
    assert.equal(response.details.cancelled, false);
    assert.equal(response.details.globalNote, "Ship it.");
    assert.equal(response.details.result.status, "completed");
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

  it("rejects image bytes that do not match the provider MIME type", async () => {
    const review = normalizeReview({
      reviewId: "bad-image",
      stages: [{ header: "Choice", prompt: "Choose", options: [
        { label: "A", generate: { prompt: "A" } },
        { label: "B" },
      ] }],
    });
    await assert.rejects(
      generateReviewImages(review, {
        cwd: process.cwd(),
        resolveCredential: () => "test-key",
        fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=", mime_type: "image/png" }] }), { status: 200 }),
      }),
      (error) => error instanceof ImageGenerationError && error.code === "invalid_response",
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

/**
 * An image that is dropped without a word is the worst failure a visual tool
 * can have: the review renders perfectly and simply has nothing to show. Hosts
 * present the artwork on the question rather than on each option, so that shape
 * is honoured positionally - and a shape that cannot be honoured is an error,
 * not a silence.
 */
describe("images presented per question are not dropped", () => {
  it("maps a question-level image array onto the options, in order", () => {
    const fromQuestions = normalizeReview({
      reviewId: "q-images",
      questions: [{
        question: "Which treatment?",
        header: "Layout",
        options: [{ label: "A" }, { label: "B" }, { label: "C" }],
        image: [{ path: "/tmp/a.png" }, { path: "/tmp/b.png" }],
      }],
    });
    assert.deepEqual(fromQuestions.stages[0].options.map((option) => option.image?.path), ["/tmp/a.png", "/tmp/b.png", undefined]);

    const fromStages = normalizeReview({
      reviewId: "s-images",
      stages: [{
        header: "Layout",
        prompt: "Which treatment?",
        images: [{ path: "/tmp/a.png" }, { path: "/tmp/b.png" }],
        options: [{ label: "A" }, { label: "B" }],
      }],
    });
    assert.deepEqual(fromStages.stages[0].options.map((option) => option.image?.path), ["/tmp/a.png", "/tmp/b.png"]);
  });

  it("an option's own image wins over the stage-level one", () => {
    const review = normalizeReview({
      reviewId: "precedence",
      stages: [{
        header: "H", prompt: "P",
        images: [{ path: "/stage-a.png" }, { path: "/stage-b.png" }],
        options: [{ label: "A", image: { path: "/option.png" } }, { label: "B" }],
      }],
    });
    assert.deepEqual(review.stages[0].options.map((option) => option.image?.path), ["/option.png", "/stage-b.png"]);
  });

  it("an image list that cannot be honoured is an error, not a silent drop", () => {
    assert.throws(() => normalizeReview({
      reviewId: "too-many",
      stages: [{ header: "H", prompt: "P", images: [{ path: "/a.png" }, { path: "/b.png" }, { path: "/c.png" }], options: [{ label: "A" }, { label: "B" }] }],
    }), /carries 3 images for 2 options/);
    assert.throws(() => normalizeReview({
      reviewId: "not-an-image",
      stages: [{ header: "H", prompt: "P", images: ["/a.png"], options: [{ label: "A" }, { label: "B" }] }],
    }), /image 1 must be an object/);
    // An object with nothing drawable in it - a nested wrapper, say - is the
    // shape that was quietly dropped when a live review showed no picture.
    assert.throws(() => normalizeReview({
      reviewId: "empty-image",
      stages: [{ header: "H", prompt: "P", images: [{ item: { path: "/a.png" } }], options: [{ label: "A" }, { label: "B" }] }],
    }), /image 1 has no path, url or dataUri, so there is nothing to draw/);
  });
});

/**
 * The terminal behind the multiplexer.
 *
 * pi-tui refuses to emit graphics whenever `TMUX` is set, so a review inside
 * tmux loses its pictures even when Ghostty is underneath and perfectly
 * capable. The package asks the multiplexer what is on the other side and turns
 * the protocol on when that terminal speaks it - which it never does when the
 * host already works, and never when the terminal is unknown.
 */
describe("images through a multiplexer", () => {
  it("enables the protocol when the terminal behind the multiplexer can draw", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const loader = await import("../src/image-loader.ts");
    const previousTmux = process.env.TMUX;
    const previousCaps = setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    try {
      for (const terminal of ["xterm-ghostty", "xterm-kitty", "xterm-wezterm", "xterm-warp"]) {
        setCapabilities({ images: null, trueColor: true, hyperlinks: false });
        loader.resetMultiplexerProbe();
        process.env.TMUX = "fake";
        const result = loader.enableImagesThroughMultiplexer({ probe: () => terminal });
        assert.equal(result.enabled, true, `${terminal} speaks the Kitty protocol`);
        assert.equal(result.terminal, terminal, "and the terminal is named for the message");
        assert.equal(loader.canRenderImages(), true, `${terminal} can now draw images`);
      }
    } finally {
      if (previousCaps) setCapabilities(previousCaps);
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      loader.resetMultiplexerProbe();
    }
  });

  it("leaves a host it cannot vouch for exactly as it found it", async () => {
    const { setCapabilities, getCapabilities } = await import("@earendil-works/pi-tui");
    const loader = await import("../src/image-loader.ts");
    const previousTmux = process.env.TMUX;
    const previousCaps = setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    try {
      process.env.TMUX = "fake";
      for (const terminal of ["screen", "xterm-256color", "", null]) {
        setCapabilities({ images: null, trueColor: true, hyperlinks: false });
        loader.resetMultiplexerProbe();
        const result = loader.enableImagesThroughMultiplexer({ probe: () => terminal });
        assert.equal(result.enabled, false, `${terminal ?? "nothing"} is not a terminal we vouch for`);
        assert.equal(loader.canRenderImages(), false, "so the review still falls back honestly");
      }
      // A host that already draws images is never second-guessed.
      setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
      loader.resetMultiplexerProbe();
      const already = loader.enableImagesThroughMultiplexer({ probe: () => { throw new Error("must not probe"); } });
      assert.equal(already.enabled, true, "a working host is left alone");
      assert.equal(getCapabilities().images, "kitty");
    } finally {
      if (previousCaps) setCapabilities(previousCaps);
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      loader.resetMultiplexerProbe();
    }
  });
});
