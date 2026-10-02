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
  carryOverPresentation,
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
      images: "on",
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
 * Images are off unless a review asks for them.
 *
 * The photograph is the part of a preview that carries no information, and the
 * part that needs a terminal speaking a graphics protocol. The drawn structure
 * is the default; `images: "on"` is how the benchmark and the live smoke still
 * get a picture to look at.
 */
describe("images are off by default, and opt-in", () => {
  it("normalises to off unless the review says on", () => {
    assert.equal(normalizeReview({ reviewId: "a", stages: [{ header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }] }).images, "off");
    assert.equal(normalizeReview({ reviewId: "b", images: "on", stages: [{ header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }] }).images, "on");
    assert.throws(
      () => normalizeReview({ reviewId: "c", images: "maybe", stages: [{ header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }] }),
      /images must be "off" or "on"/,
    );
  });

  it("a review with an image and no opt-in does not draw it, and says why", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { fileURLToPath } = await import("node:url");
    const { VisualReviewWizard } = await import("../src/tui.ts");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
    const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
    try {
      const stage = { id: "one", header: "One", prompt: "Pick", options: [
        { id: "a", label: "A", description: "First.", image: { path: fixture, alt: "fixture" } },
        { id: "b", label: "B", description: "Second.", image: { path: fixture, alt: "fixture" } },
      ] };
      for (const images of [undefined, "on"]) {
        let result;
        const review = normalizeReview({ reviewId: images ? "on" : "off", ...(images ? { images } : {}), stages: [stage] });
        const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, theme, review, process.cwd(), (value) => { result = value; });
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
        const frame = component.render(100);
        const drawn = frame.some((line) => line.includes("\u001b_G") || line.includes("1337"));
        if (images) assert.equal(drawn, true, "images: on draws the picture");
        else assert.equal(drawn, false, "the default does not draw it");
        component.dispose();
      }
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * `option.changes` is the model's way to fill the content area with the thing a
 * reviewer actually reads: what the option would change.
 */
describe("option.changes survives normalisation", () => {
  it("keeps the lines in order, drops the blank ones, and is optional", () => {
    const review = normalizeReview({
      reviewId: "changes",
      stages: [{ id: "one", header: "H", prompt: "P", options: [
        { id: "a", label: "A", changes: ["  first  ", "", "second"] },
        { id: "b", label: "B" },
      ] }],
    });
    assert.deepEqual(review.stages[0].options[0].changes, ["  first  ", "second"]);
    assert.equal(review.stages[0].options[1].changes, undefined, "an option without changes has none");
  });
  it("carries the image mode through a resumed round", () => {
    const review = normalizeReview({
      reviewId: "round", round: 2, images: "on",
      stages: [{ id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }],
    });
    assert.equal(review.images, "on");
  });
});

/**
 * `density` is a real input value: it is validated, it defaults, and a resumed
 * round keeps the presentation it was opened with.
 */
describe("density is validated, defaulted and remembered", () => {
  const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };

  it("defaults to comfortable and accepts only the two named values", () => {
    assert.equal(normalizeReview({ reviewId: "a", stages: [stage] }).density, "comfortable");
    assert.equal(normalizeReview({ reviewId: "b", density: "comfortable", stages: [stage] }).density, "comfortable");
    assert.equal(normalizeReview({ reviewId: "c", density: "compact", stages: [stage] }).density, "compact");
    assert.throws(
      () => normalizeReview({ reviewId: "d", density: "roomy", stages: [stage] }),
      /density must be "comfortable" or "compact"/,
      "an unknown density is an error naming the two allowed values",
    );
  });

  it("a persisted round restores the density it was opened with", async () => {
    const { makeReviewState, findReviewState } = await import("../src/state.ts");
    const review = normalizeReview({
      reviewId: "e", round: 2, density: "compact",
      stages: [{ id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] }],
    });
    const state = makeReviewState(review, [], "cancelled");
    assert.equal(state.density, "compact", "the state carries it");
    // A session entry is a custom-typed envelope; the state lives inside it.
    const found = findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], "e");
    assert.equal(found?.density, "compact", "and it is found again on resume");
  });
});

/**
 * A resumed round keeps the density it was opened with.
 *
 * The state carries it and the *extension* re-applies it, because the wizard is
 * built from the round-2 review the model re-sends. Carrying it in the state
 * alone is not enough: when the model omits the field, `normalizeReview`
 * defaults to comfortable and the user's mode is lost mid-review.
 */
describe("a resumed round re-applies the persisted density", () => {
  it("round two keeps compact when the model does not re-send the field", async () => {
    // The product's rule, called - not a copy of it written here. This suite
    // used to re-implement the carry-over and assert on its own version, so the
    // extension could stop carrying the density over and everything would still
    // pass; a test that copies the rule it is testing tests itself.
    const { normalizeReview } = await import("../src/schema.ts");
    const { makeReviewState, findReviewState, carryOverPresentation } = await import("../src/state.ts");
    const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
    const round1 = normalizeReview({ reviewId: "r", round: 1, density: "compact", stages: [stage] });
    const state = makeReviewState(round1, [], "cancelled");
    const previous = findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], "r");
    assert.equal(previous?.density, "compact", "round 1 persisted compact");

    // Round 2: the model re-sends the review without the field, exactly as a
    // revision round normally arrives.
    let review = normalizeReview({ reviewId: "r", round: 2, stages: [stage] });
    assert.equal(review.density, "comfortable", "the model left it out, so it defaults");
    // The extension's carry-over, which is this call and nothing else.
    review = carryOverPresentation(review, previous);
    assert.equal(review.density, "compact", "and the resumed round keeps the presentation it had");
    assert.equal(review.images, previous?.images ?? review.images, "and the images setting with it");
  });

  it("a model that re-sends compact keeps compact", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const { makeReviewState, findReviewState, carryOverPresentation } = await import("../src/state.ts");
    const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
    const round1 = normalizeReview({ reviewId: "r2", round: 1, density: "comfortable", stages: [stage] });
    const state = makeReviewState(round1, [], "cancelled");
    const previous = findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], "r2");
    let review = normalizeReview({ reviewId: "r2", round: 2, density: "compact", stages: [stage] });
    review = carryOverPresentation(review, previous);
    assert.equal(review.density, "compact", "an explicit round-2 choice is honoured");
  });

  it("the carry-over is a floor: compact is kept, and Ctrl+D is the way back", async () => {
    // The rule only ever lifts comfortable to compact, never the reverse, so a
    // round cannot land back in comfortable while the previous one was compact.
    // That is deliberate rather than an oversight: compact is a mode the *person*
    // chose, and a revision round arriving without the field should not take it
    // away. The way back is Ctrl+D, which is a view choice and overrides whatever
    // this returns.
    //
    // Worth stating, because "the model re-sends comfortable and gets compact
    // anyway" reads like a bug until you know which one the density belongs to.
    const { normalizeReview } = await import("../src/schema.ts");
    const { makeReviewState, findReviewState, carryOverPresentation } = await import("../src/state.ts");
    const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
    const round1 = normalizeReview({ reviewId: "r3", round: 1, density: "compact", stages: [stage] });
    const state = makeReviewState(round1, [], "cancelled");
    const previous = findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], "r3");
    assert.equal(previous?.density, "compact", "round 1 persisted compact");
    const review = carryOverPresentation(normalizeReview({ reviewId: "r3", round: 2, stages: [stage] }), previous);
    assert.equal(review.density, "compact", "the previous compact sticks");
    // And the other direction really is reachable, so this is a one-way floor
    // rather than a permanent lock.
    const back = normalizeReview({ reviewId: "r3", round: 2, stages: [stage] });
    back.density = "comfortable";
    assert.equal(carryOverPresentation(back, undefined).density, "comfortable", "with no previous round, comfortable stands");
  });
});

describe("how many rounds are left", () => {
  it("carries a total when the model says one, and validates it", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
    assert.equal(normalizeReview({ reviewId: "r", round: 1, rounds: 3, stages: [stage] }).rounds, 3, "the total is carried");
    assert.equal(normalizeReview({ reviewId: "r", stages: [stage] }).rounds, undefined, "and is absent when the model did not say");
    assert.throws(() => normalizeReview({ reviewId: "r", rounds: 0, stages: [stage] }), /rounds must be a positive integer/);
    assert.throws(() => normalizeReview({ reviewId: "r", rounds: 1.5, stages: [stage] }), /rounds must be a positive integer/);
    // A total below the round already reached is not a total, it is a mistake,
    // and "round 3 of 2" in the header would be worse than no total at all.
    assert.throws(() => normalizeReview({ reviewId: "r", round: 3, rounds: 2, stages: [stage] }), /cannot be less than round/);
  });

  it("says round 1 of 3 in the header when there is a total, and round 1 when there is not", async () => {
    const { VisualReviewWizard } = await import("../src/tui.ts");
    const { normalizeReview } = await import("../src/schema.ts");
    const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
    const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
    const header = (review) => new VisualReviewWizard(
      { requestRender: () => {}, terminal: { rows: 40 } }, theme, review, process.cwd(), () => {},
    ).render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).find((line) => /Visual review/.test(line)) ?? "";
    assert.match(header(normalizeReview({ reviewId: "r", round: 1, rounds: 3, stages: [stage] })), /round 1 of 3/);
    assert.match(header(normalizeReview({ reviewId: "r", round: 2, rounds: 3, stages: [stage] })), /round 2 of 3/);
    assert.match(header(normalizeReview({ reviewId: "r", round: 2, stages: [stage] })), /\(round 2\)/);
    assert.doesNotMatch(header(normalizeReview({ reviewId: "r", round: 1, stages: [stage] })), / of /);
  });
});

describe("the model is told to draw, not only that it may", () => {
  it("the tool description points at mockup as the default for a visual comparison", async () => {
    const { TOOL_DESCRIPTION, PROMPT_GUIDELINES } = await import("../extensions/visual-review.ts");
    // A mockup can be rendered all day and the model will never send one, because
    // nothing it reads mentions it. This is the wiring: the field existed, the
    // renderer existed, and the only description the model sees said nothing.
    assert.match(TOOL_DESCRIPTION, /prefer option\.mockup/i, "the tool description says to prefer a mockup");
    assert.match(TOOL_DESCRIPTION, /31 x 16 cell grid/i, "and says what it is drawn on");
    assert.match(TOOL_DESCRIPTION, /list, airy, split, dense, rail/i, "and names the layouts it can choose between");
    assert.match(TOOL_DESCRIPTION, /costs no provider quota/i, "and that it is free of provider quota");
    assert.match(
      PROMPT_GUIDELINES.join(" "),
      /prefer options\[\]\.mockup/i,
      "the session guidelines say the same",
    );
    assert.match(
      TOOL_DESCRIPTION,
      /when the artefact is a photograph|whose pixels are the point/i,
      "and it says when a generated image is still the right answer",
    );
  });

  it("a mockup always gets enough cells to draw a row of content", async () => {
    // The artwork can legitimately be handed three rows by the yield floor, and
    // a mockup spends two of them on its title and row count. At four cells it
    // rendered as an empty box.
    const { VisualReviewWizard } = await import("../src/tui.ts");
    const { normalizeReview } = await import("../src/schema.ts");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
      const review = normalizeReview({
        reviewId: "draw", images: "off",
        stages: [{
          id: "one", header: "Treatment", prompt: "Which treatment ships first?",
          options: [0, 1].map((index) => ({
            id: `o${index}`, label: `Option ${index + 1}`,
            description: `Favors option ${index + 1}; a one-to-two sentence reason line.`,
            mockup: { layout: "airy", title: "Operations", rows: [
              { label: "On time", value: 0.98 }, { label: "Active", value: 0.7 }, { label: "Delayed", value: 0.3 },
            ] },
          })),
        }],
      });
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, theme, review, process.cwd(), () => {});
      const frame = component.render(100).join("\n");
      const drawn = /\u001b_G/.test(frame);
      assert.ok(drawn, "the mockup is drawn at all");
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * The schema declares limits that nothing was enforcing.
 *
 * There is no runtime TypeBox validation in this project, so every `maxLength`,
 * `maxItems` and `Type.Literal` union in `src/schema.ts` is documentation until
 * `normalizeReview` checks it. These are the declarations that were not checked:
 * a NaN bar value, an unknown layout, a negative canvas width, unbounded
 * headers, a 400-character change line, and a fifth legacy question all used to
 * be accepted and reach the renderer.
 */
describe("declared limits that were not enforced", () => {
  const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };
  const withMockup = (mockup) => normalizeReview({
    reviewId: "r",
    stages: [{ id: "one", header: "H", prompt: "P", options: [{ ...stage.options[0], mockup }, stage.options[1]] }],
  });

  it("rejects a mockup that cannot be drawn or read", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const row = { label: "On time", value: 0.9 };
    // NaN passes every comparison written as `value < 0 || value > 1`, so it
    // used to reach the bar renderer as a bar width.
    assert.throws(() => withMockup({ layout: "airy", rows: [row, { label: "x", value: NaN }] }), /value must be a number between 0 and 1/);
    assert.throws(() => withMockup({ layout: "wobbly", rows: [row] }), /layout must be one of/);
    assert.throws(() => withMockup({ layout: "airy", emphasis: "shouty", rows: [row] }), /emphasis must be one of/);
    assert.throws(() => withMockup({ layout: "airy", rows: [{ ...row, status: "chartreuse" }] }), /status must be one of/);
    // These become `new Canvas(widthCells * 8, heightCells * 16)` directly.
    assert.throws(() => withMockup({ layout: "airy", widthCells: -3, rows: [row] }), /widthCells must be a number between/);
    assert.throws(() => withMockup({ layout: "airy", heightCells: NaN, rows: [row] }), /heightCells must be a number between/);
    assert.throws(() => withMockup({ layout: "airy", widthCells: 2e6, rows: [row] }), /widthCells must be a number between/);
    // Declared maxima that were never checked.
    assert.throws(() => withMockup({ layout: "chart", headers: ["a", "b", "c", "d", "e"], rows: [row] }), /at most 4 headers/);
    assert.throws(() => withMockup({ layout: "airy", rows: [{ ...row, code: "far too long to be a badge" }] }), /code is longer than 6/);
    assert.throws(() => withMockup({ layout: "airy", rows: [{ ...row, detail: "x".repeat(201) }] }), /detail is longer than 200/);
    // And the accepted shape still normalises.
    assert.equal(withMockup({ layout: "airy", rows: [row] }).stages[0].options[0].mockup.layout, "airy");
  });

  it("rejects an unbounded change list or a mistyped recommended flag", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const build = (option) => normalizeReview({ reviewId: "r", stages: [{ ...stage, options: [option, stage.options[1]] }] });
    assert.throws(() => build({ label: "A", changes: ["x".repeat(281)] }), /changes\[0\] is longer than 280/);
    assert.equal(build({ label: "A", changes: ["one", "two"] }).stages[0].options[0].changes.length, 2);
    // Twenty declared, sixteen kept: the list is bounded rather than rejected.
    assert.equal(build({ label: "A", changes: Array.from({ length: 20 }, (_, i) => `c${i}`) }).stages[0].options[0].changes.length, 16);
    // `recommended: "yes"` used to be silently dropped.
    assert.throws(() => build({ label: "A", recommended: "yes" }), /recommended must be true when present/);
    assert.equal(build({ label: "A", recommended: true }).stages[0].options[0].recommended, true);
  });

  it("rejects more than the four legacy questions the schema declares", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const questions = ["one", "two", "three", "four"].map((prompt, index) => ({
      question: prompt, options: [{ label: `A${index}` }, { label: `B${index}` }],
    }));
    assert.equal(normalizeReview({ reviewId: "r", questions }).stages.length, 4);
    assert.throws(() => normalizeReview({ reviewId: "r", questions: [...questions, { question: "five", options: [{ label: "A" }, { label: "B" }] }] }), /at most 4 questions/);
  });
});

/**
 * The presentation state a resumed round needs, and did not have.
 *
 * `rounds` was validated on the way in and then never written to the state, so a
 * resumed round could never say "round 2 of 3" - the header silently degraded to
 * "round 2", which is the whole promise the field was added to keep. Ctrl+A was
 * never persisted at all, so a chosen mode was lost across a revision. Neither
 * survives a round trip unless something reads it back.
 */
describe("what a resumed round needs to look the same", () => {
  const stage = { id: "one", header: "H", prompt: "P", options: [{ label: "A" }, { label: "B" }] };

  it("persists the round total and the auto-resolve mode", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const { makeReviewState, findReviewState, carryOverPresentation } = await import("../src/state.ts");
    const review = normalizeReview({ reviewId: "r", round: 2, rounds: 4, autoResolve: true, stages: [stage] });
    const state = makeReviewState(review, [], "cancelled");
    assert.equal(state.rounds, 4, "the total is written, so the header can say 'round 2 of 4'");
    assert.equal(state.autoResolve, true, "and so is the Ctrl+A mode");
    const found = findReviewState([{ type: "custom", customType: "pi-visual-review-state", data: state }], "r");
    assert.equal(found?.rounds, 4, "and both come back on resume");
    assert.equal(found?.autoResolve, true, "including auto-resolve");
    const next = normalizeReview({ reviewId: "r", round: 3, stages: [stage] });
    const carried = carryOverPresentation(next, found);
    assert.equal(carried.rounds, 4, "the expected total carries forward");
    assert.equal(carried.autoResolve, true, "and so does the mode");
    assert.equal(carried.density, next.density, "an explicit choice is never overridden");
  });

  it("validates the persisted presentation rather than coercing it", async () => {
    const { normalizeReview } = await import("../src/schema.ts");
    const { makeReviewState, findReviewState } = await import("../src/state.ts");
    const good = makeReviewState(normalizeReview({ reviewId: "r", stages: [stage] }), [], "cancelled");
    const asState = (data) => findReviewState([{ type: "custom", customType: "pi-visual-review-state", data }], "r");
    // A state written by a different or older tool should not be able to change
    // the presentation mode with no error at all.
    assert.equal(asState({ ...good, density: "banana" }), undefined, "a bogus density is not a valid state");
    assert.equal(asState({ ...good, images: "sometimes" }), undefined, "and neither is a bogus images value");
    assert.ok(asState(good), "a good state is still found");
  });
});

/**
 * The envelope is the model's only view of what happened, and the prompt
 * guidelines tell it to read a cancelled decision as an explicit user
 * cancellation. Three places were saying less than the code did.
 */
describe("the envelope says what actually happened", () => {
  it("a failed review is not flagged as a cancellation", () => {
    // The prose already said "This is not a user decision". The flag a level up
    // said the user declined, on the same payload, and the benchmark's own
    // ledger turned that flag into a durable `cancelled` classification.
    const response = errorResponse("the image provider is unreachable", baseReview());
    assert.equal(response.details.cancelled, false, "details.cancelled must agree with result.cancelled");
    assert.equal(response.details.result.status, "failed");
    assert.equal(response.details.result.cancelled, false);
    assert.match(response.content[0].text, /could not start/);
    assert.doesNotMatch(response.details.result.error ?? "", /declin/i);
  });

  it("names the stages the user skipped, on their own and alongside answers", () => {
    const review = reviewWith([
      { id: "layout", header: "Layout", prompt: "Choose a layout", required: false, options: [{ id: "grid", label: "Grid", value: "grid" }, { id: "stack", label: "Stack", value: "stack" }] },
      { id: "mood", header: "Mood", prompt: "Choose a mood", required: false, options: [{ id: "calm", label: "Calm" }, { id: "loud", label: "Loud" }] },
    ]);
    // Both skipped is a legitimate outcome: every stage is optional, so
    // skipping all of them is how the user says "neither, carry on".
    const skippedOnly = buildResponse(makeReviewResult(review, "approve", [], undefined, ["layout", "mood"]), review);
    assert.match(skippedOnly.content[0].text, /skipped: layout, mood/, "an all-skipped review must still name what was skipped");

    const mixed = buildResponse(makeReviewResult(review, "approve", [answerFor(review, "layout", "grid")], undefined, ["mood"]), review);
    assert.match(mixed.content[0].text, /skipped by the user: mood/, "a skip must be named next to the answers");
    assert.match(mixed.content[0].text, /Grid/, "and must not displace them");

    const none = buildResponse(makeReviewResult(review, "approve", [answerFor(review, "layout", "grid"), answerFor(review, "mood", "calm")]), review);
    assert.doesNotMatch(none.content[0].text, /skipped/, "no skip means no skip line");
  });
});

/**
 * `state.ts` is the second gate: `isReviewState` is the only check a persisted
 * entry passes on resume, and it re-runs `validateReview`. So every rule
 * `normalizeReview` enforces but `validateReview` does not is a hole on the
 * resume path, and anything written that the reader rejects is work the user's
 * round silently loses.
 */
describe("what a resumed round reads back is what was written", () => {
  const persisted = (overrides) => {
    const review = baseReview();
    // "cancelled" rather than "completed": an unresolved stage cannot be persisted as approved.
    const state = makeReviewState(review, [], "cancelled");
    return { ...state, ...overrides };
  };

  it("a carried total that no longer bounds the round is not written into the state", () => {
    // The extension validates the review, *then* carries the presentation
    // forward, and nothing validates the combination afterwards. A total of 3
    // carried into round 4 produces a state `isReviewState` refuses on every
    // later read, so round 4's answers, skips, note and generated images
    // disappear with no error.
    assert.throws(
      () => validateReview({ ...baseReview(), round: 4, rounds: 3 }),
      /cannot be less than round/,
      "the combination is refused by the reader, which is the problem",
    );
    const carried = carryOverPresentation({ round: 4 }, { rounds: 3 });
    assert.equal(carried.rounds, undefined, "so a total that cannot bound the round must not be carried");
    assert.doesNotThrow(() => validateReview({ ...baseReview(), ...carried }), "and what is carried still validates");

    // The ordinary case still carries, which is the whole point of it.
    assert.equal(carryOverPresentation({ round: 2 }, { rounds: 3 }).rounds, 3, "a total that still bounds the round is carried");
    assert.equal(carryOverPresentation({ round: 3 }, { rounds: 3 }).rounds, 3, "including a round equal to the total");
    assert.equal(carryOverPresentation({ round: 2, rounds: 5 }, { rounds: 3 }).rounds, 5, "and an explicit total wins");
  });

  it("a mockup row value of NaN is refused on the restore path, as it is on the input path", () => {
    // Every comparison with NaN is false, so the range test passed it. The
    // input path was hardened by `boundedNumber`; this is the path a restored
    // state takes, and the comment in state.ts calls this the only gate it
    // passes through.
    const review = baseReview();
    const withNaNReview = () => ({
      reviewId: review.reviewId,
      title: review.title,
      round: review.round,
      stages: [{
        ...review.stages[0],
        options: [
          { id: "grid", label: "Grid", value: "grid", mockup: { layout: "list", title: "T", rows: [{ label: "r", value: Number.NaN }] } },
          { id: "stack", label: "Stack", value: "stack" },
        ],
      }],
    });
    assert.throws(() => validateReview(withNaNReview()), /between 0 and 1/, "NaN must not survive validateReview");
    assert.throws(
      () => normalizeReview(withNaNReview()),
      /must be a number between 0 and 1/,
      "the input path already rejected it",
    );
  });

  it("refuses a persisted autoResolve that is not a boolean, rather than coercing it", () => {
    assert.equal(isReviewState(persisted({ autoResolve: true })), true, "a real boolean is fine");
    assert.equal(isReviewState(persisted({ autoResolve: false })), true, "including false");
    assert.equal(isReviewState(persisted({ autoResolve: "yes" })), false, "a string is refused");
    assert.equal(isReviewState(persisted({ autoResolve: 1 })), false, "and so is a number");
    // The coercion turned `autoResolve: "yes"` into false, silently switching
    // Ctrl+A off in a resumed review rather than refusing the entry.
    assert.equal(isReviewState(persisted({ images: "bogus" })), false, "the same rule the sibling fields already follow");
    assert.equal(isReviewState(persisted({ density: "huge" })), false);
  });

  it("a persisted status the reader does not know is a trap, so the two lists agree", () => {
    for (const status of ["completed", "revision", "rejected", "cancelled", "fallback", "failed"]) {
      assert.equal(isReviewState(persisted({ status })), true, `a persisted ${status} must be readable back`);
    }
  });
});
