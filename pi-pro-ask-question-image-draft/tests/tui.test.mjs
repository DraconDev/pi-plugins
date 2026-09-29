import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { terminateITerm2Images, VisualReviewWizard } from "../src/tui.ts";
import { normalizeReview } from "../src/schema.ts";

function theme() {
  return { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
}

function review() {
  return normalizeReview({
    reviewId: "tui-unit",
    title: "TUI unit",
    stages: [
      { id: "one", header: "One", prompt: "Choose one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
      { id: "many", header: "Many", prompt: "Choose many", multiSelect: true, options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
      { id: "optional", header: "Optional", prompt: "Optional", required: false, options: [{ id: "e", label: "E" }, { id: "f", label: "F" }] },
    ],
  });
}

function wizard(signal) {
  let result;
  let renders = 0;
  const component = new VisualReviewWizard({ requestRender: () => { renders += 1; }, terminal: { rows: 40 } }, theme(), review(), process.cwd(), (value) => { result = value; }, [], signal);
  return { component, get result() { return result; }, get renders() { return renders; } };
}

function enter(component) { component.handleInput("\r"); }
function down(component) { component.handleInput("\x1b[B"); }

/** The label of the row the cursor is on, read off the rendered frame. */
function activeRow(component, width = 100) {
  for (const line of component.render(width)) {
    const match = /(?:^|\s)>\s?(\S.*)$/.exec(line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    if (match) return match[1].trim().replace(/^(?:\[x\]|\[ \]|\d+\.|✓ )\s*/, "").replace(/ \(recommended\)$/, "");
  }
  return null;
}

/**
 * Walk to a row by its label, the way a person reads the screen.
 *
 * Navigating by index made every test that added a row a test to re-count, and
 * the count is not what those tests are about.
 */
function moveTo(component, label, width = 100) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = activeRow(component, width);
    if (current === label) return current;
    down(component);
  }
  throw new Error(`never reached the "${label}" row; the cursor is on "${activeRow(component, width)}"`);
}

describe("VisualReviewWizard", () => {
  it("matches real Enter, newline, and escape input", () => {
    assert.equal(matchesKey("\r", Key.enter), true);
    assert.equal(matchesKey("\n", Key.enter), true);
    assert.equal(matchesKey("\r", Key.space), false);
    assert.equal(matchesKey("\x1b", Key.escape), true);
  });

  it("walks single, multi, and explicit optional skip before approval", () => {
    const state = wizard();
    enter(state.component);
    // The multi-select stage: check both options, then commit with Done.
    state.component.handleInput(" ");
    down(state.component);
    state.component.handleInput(" ");
    moveTo(state.component, "Done selecting");
    enter(state.component);
    // The optional stage is skipped explicitly, not silently approved.
    moveTo(state.component, "Skip stage");
    enter(state.component);
    enter(state.component);
    assert.equal(state.result?.status, "completed");
    assert.deepEqual(state.result?.answers.map((answer) => answer.stageId), ["one", "many"]);
    assert.deepEqual(state.result?.skippedStageIds, ["optional"]);
    assert.equal(state.renders > 0, true);
  });

  it("uses Enter to toggle multi-select options and only Done selecting to commit", () => {
    const state = wizard();
    state.component.handleInput("\t");
    state.component.handleInput("\r");
    assert.match(state.component.render(100).join("\n"), /Selected: C/);
    assert.equal(state.result, undefined);
    state.component.handleInput("\x1b[B");
    state.component.handleInput("\r");
    assert.match(state.component.render(100).join("\n"), /Selected: C, D/);
    assert.equal(state.result, undefined);
    state.component.handleInput("\x1b[B");
    state.component.handleInput("\r");
    assert.equal(state.result, undefined);
    // The first unresolved stage is revisited rather than silently approving.
    assert.match(state.component.render(100).join("\n"), /Choose one/);
  });

  it("submits custom and revision editor text and clears it", () => {
    const state = wizard();
    moveTo(state.component, "Type something.");
    enter(state.component);
    state.component.handleInput("hello");
    enter(state.component);
    state.component.handleInput(" ");
    down(state.component);
    state.component.handleInput(" ");
    moveTo(state.component, "Done selecting");
    enter(state.component);
    // The optional stage is still open, so it is answered or skipped before the
    // final review offers to approve.
    moveTo(state.component, "Skip stage");
    enter(state.component);
    moveTo(state.component, "Approve review");
    enter(state.component);
    assert.equal(state.result?.status, "completed");
    assert.equal(state.result?.answers[0].kind, "custom");
    assert.equal(state.result?.answers[0].customText, "hello");

    const revisionState = wizard();
    moveTo(revisionState.component, "Request revision");
    enter(revisionState.component);
    revisionState.component.handleInput("make it bolder");
    enter(revisionState.component);
    assert.equal(revisionState.result?.status, "revision");
    assert.equal(revisionState.result?.revision?.feedback, "make it bolder");
    assert.equal(revisionState.result?.revision?.requestedRound, 2);
  });

  it("supports final review, global notes, and explicit rejection", () => {
    let result;
    const finalReview = normalizeReview({
      reviewId: "final-review",
      stages: [{ id: "only", header: "Only", prompt: "Choose one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
    });
    const component = new VisualReviewWizard(
      { requestRender: () => {}, terminal: { rows: 40, columns: 100 } },
      theme(),
      finalReview,
      process.cwd(),
      (value) => { result = value; },
    );
    component.handleInput("\t");
    component.handleInput("n");
    component.handleInput("more context");
    component.handleInput("\r");
    assert.match(component.render(100).join("\n"), /Global note: more context/);
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    assert.equal(result?.status, "rejected");
    assert.equal(result?.globalNote, "more context");
  });

  it("cancels on Escape and AbortSignal", () => {
    const escapeState = wizard();
    escapeState.component.handleInput("\x1b");
    assert.equal(escapeState.result?.status, "cancelled");

    const controller = new AbortController();
    const abortState = wizard(controller.signal);
    controller.abort();
    assert.equal(abortState.result?.status, "cancelled");
    assert.equal(abortState.result?.cancelled, true);
  });
});

/**
 * Chrome: the dialog is read by a person, at a glance, next to the reference
 * extension. These pin the three things that made it read as unfinished: rows
 * without numbers, per-row descriptions wrapped into ragged blocks beside an
 * image, and a preview pane that said nothing at all when the host could not
 * draw one.
 */
describe("TUI chrome: rows, the preview pane and image-host honesty", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const chromeReview = () => normalizeReview({
    reviewId: "chrome",
    title: "Chrome",
    stages: [{
      id: "one", header: "One", prompt: "Pick a treatment",
      options: [
        { id: "a", label: "Transit airy", description: "Favors quick orientation; trade-off: less detail in secondary states." },
        { id: "b", label: "Transit split", description: "Favors balanced context; trade-off: more visual density to scan." },
      ],
    }],
  });
  const build = (terminal) => {
    let result;
    const component = new VisualReviewWizard(
      { requestRender: () => {}, terminal },
      plainTheme,
      chromeReview(),
      process.cwd(),
      (value) => { result = value; },
    );
    return { component, get result() { return result; } };
  };

  it("numbers every row so the list is scannable and the footer can name one", () => {
    const { component } = build({ rows: 40 });
    const text = component.render(110).join("\n");
    assert.match(text, /> 1\. Transit airy/, "the selected row is numbered");
    assert.match(text, /\n\s+2\. Transit split/);
    // The action rows are deliberately *not* numbered: "press 2" should never
    // be a way to skip the question or ask for a revision.
    assert.match(text, /\n\s+Add note\b/);
    assert.match(text, /\n\s+Type something\./);
    assert.match(text, /\n\s+Request revision/);
    assert.equal(/\n\s+\d+\. (Type something|Request revision|Add note|Add global note)/.test(text), false);
    component.dispose();
  });

  it("stacks the artwork above the action, one row per option, nothing clipped", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { fileURLToPath } = await import("node:url");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
      const review = normalizeReview({
        images: "on",
        reviewId: "stacked",
        stages: [{
          id: "one", header: "One", prompt: "Pick a treatment",
          options: [
            { id: "a", label: "Transit airy", description: "Favors quick orientation; trade-off: less detail in secondary states.", image: { path: fixture, alt: "Fixture" } },
            { id: "b", label: "Transit split", description: "Favors balanced context; trade-off: more visual density to scan.", image: { path: fixture, alt: "Fixture" } },
          ],
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
      assert.ok(component.loadedImages.size > 0, "the image must load");
      const frame = component.render(100);
      const rows = [...frame].map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
      // One row per option, and the sentence on its own line at full width -
      // not wrapped into a narrow column beside the artwork.
      assert.equal(rows.filter((line) => /^ > 1\. Transit airy$/.test(line)).length, 1, "the option is one row");
      assert.equal(rows.filter((line) => /Favors quick orientation; trade-off: less detail in secondary states\./.test(line)).length, 1, "its description is spelled out once, at full width");
      // The artwork is inline and comes before the action.
      const artAt = frame.findIndex((line) => line.includes("\u001b_G"));
      const questionAt = rows.findIndex((line) => /^\s*Pick a treatment$/.test(line));
      assert.ok(artAt >= 0, "the artwork is inline");
      assert.ok(questionAt > artAt, "and it sits above the question and the options");
      // The panel is a fixed block that leaves the host's own furniture - the
      // input line, its blank, the cwd/status line, a multiplexer bar - alone,
      // so a question never covers what you type into or the session's status.
      assert.ok(frame.length <= 40 - 5, `the panel leaves the host furniture alone (got ${frame.length} rows)`);
      assert.ok(frame.length >= 12, "and is a big enough block to work in");
      assert.doesNotMatch(rows.join("\n"), /content (above|below)/, "and no row is clipped");
      // The same question, one row more or less of content, must not resize it.
      const taller = { ...review, stages: [{ ...review.stages[0], prompt: `${review.stages[0].prompt} ${"extra ".repeat(40)}` }] };
      let tallerResult;
      const tallerWizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, normalizeReview(taller), process.cwd(), (value) => { tallerResult = value; });
      assert.equal(tallerWizard.render(100).length, frame.length, "the layout is fixed, not content-driven");
      tallerWizard.dispose();
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });

  it("says why there is no picture instead of printing a bare file path", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    // No multiplexer: this is a host that simply cannot draw, and the wizard's
    // probe must not turn the protocol on behind the test's back.
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      // A real image path: this case is the *host*, not a broken file. A missing
      // file is a different reason and has its own test.
      const real = fileURLToPath(new URL("./fixtures/tui-smoke.png", import.meta.url));
      const review = normalizeReview({
        images: "on",
        reviewId: "no-images",
        stages: [{ id: "one", header: "One", prompt: "Pick", options: [
          { id: "a", label: "A", image: { path: real, alt: "fixture" } },
          { id: "b", label: "B", image: { path: real, alt: "fixture" } },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
      // The sentence is wrapped to the pane, so compare it as prose.
      const prose = component.render(110).join(" ").replace(/\s+/g, " ");
      assert.match(prose, /images are off/i, "a host that cannot render images must say so");
      assert.match(prose, /run pi outside tmux|tmux 3\.6a strips/i, "and say what actually works");
      assert.match(prose, /pictures are off/i, "and the panel says pictures are off for this review");
      component.dispose();
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previous) setCapabilities(previous);
    }
  });
});

describe("images: the emitted sequence carries the whole image", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
  const fixtureBytes = readFileSync(fixture);

  async function frameWith(protocol) {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
        images: "on",
        reviewId: "image-bytes",
        stages: [{ id: "one", header: "One", prompt: "Pick", options: [
          { id: "a", label: "A", image: { path: fixture } },
          { id: "b", label: "B" },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
      assert.ok(component.loadedImages.size > 0, "the fixture image must load or this proves nothing");
      const frame = component.render(100).join("\r\n");
      component.dispose();
      return frame;
    } finally {
      if (previous) setCapabilities(previous);
    }
  }

  it("kitty: one complete PNG, with the placement keys a terminal needs", async () => {
    const { parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    const { images } = parseKitty(await frameWith("kitty"));
    assert.equal(images.length, 1, "one inline image for the one option that has one");
    const [image] = images;
    assert.equal(image.more, false, "the transmission is complete - the last chunk is not a continuation");
    assert.equal(image.keys.f, "100", "PNG payload");
    assert.equal(image.keys.a, "T", "transmit and display");
    assert.ok(Number(image.keys.c) > 0 && Number(image.keys.r) > 0, "a cell box is requested");
    assert.deepEqual(Buffer.from(image.payload, "base64"), fixtureBytes, "the payload is the file, byte for byte");
  });

  it("iterm2: the whole image, terminated - the regression that was missing", async () => {
    const { parseITerm2 } = await import("../scripts/benchmark/image-protocol.mjs");
    const frame = await frameWith("iterm2");
    const { images } = parseITerm2(frame);
    assert.equal(images.length, 1, "one inline image");
    const [image] = images;
    assert.equal(image.keys.inline, "1", "inline, not an attachment");
    assert.equal(Number(image.keys.size), fixtureBytes.length, "the declared size is the real size");
    const decoded = Buffer.from(image.payload, "base64");
    assert.deepEqual(decoded, fixtureBytes, "the payload is the file, byte for byte, not a 62-byte fragment");
    // The sequence must end: an unterminated OSC 1337 has no end of image for a
    // literal-minded terminal to find.
    assert.match(frame, /\u001b\]1337;File=[^\u0007\u001b]*\u0007/, "the image sequence is closed with BEL");
  });
});


/**
 * Notes, end to end.
 *
 * "Do we have a way to add notes?" is three separate affordances and a fourth
 * question - does what the user typed actually reach the model? A note that is
 * accepted on screen and then dropped is the worst outcome, so this walks all
 * three paths and reads the envelope the tool returns.
 */
describe("notes: a row, a key, a global, and all three reach the model", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const build = () => {
    const review = normalizeReview({
      reviewId: "notes",
      title: "Notes",
      stages: [
        { id: "one", header: "One", prompt: "Pick one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
        { id: "two", header: "Two", prompt: "Pick two", options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
      ],
    });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    return { component, review, get result() { return result; } };
  };
  const text = (component) => component.render(100).join("\n");
  const state_tab = (component) => component.handleInput("\t");

  it("a stage note can be typed from the Add note row, and rides the answer", () => {
    const { component } = build();
    assert.match(text(component), /\n\s+Add note\b/, "the note is a row, not a hidden key");
    moveTo(component, "Add note");
    enter(component);
    assert.match(text(component), /Add a note for this stage:/, "Enter on the row opens the note editor");
    component.handleInput("budget is fixed this quarter");
    enter(component);
    // A note on an unanswered stage is held, not lost: the answer picks it up.
    assert.match(text(component), /Note: budget is fixed this quarter/, "the note is on screen before the answer exists");
    assert.doesNotMatch(text(component), /Current answer:/, "and the stage is still unanswered");
    moveTo(component, "A");
    enter(component);
    // Answering moves the cursor to the next unresolved stage, so look back.
    for (let hop = 0; hop < 4 && !text(component).includes("Pick one"); hop += 1) state_tab(component);
    assert.match(text(component), /Current answer: A — budget is fixed this quarter/, "the answer carries the note");
    component.dispose();
  });

  it("the n key does the same thing, for a user who knows it", () => {
    const { component } = build();
    moveTo(component, "A");
    enter(component);
    component.handleInput("n");
    assert.match(text(component), /Add a note for this stage:/, "n opens the note editor too");
    component.handleInput("ship behind a flag");
    enter(component);
    assert.match(text(component), /ship behind a flag/);
    component.dispose();
  });

  it("a global note rides the whole review, and both reach the model", async () => {
    const { buildResponse } = await import("../src/envelope.ts");
    const state = build();
    // Answer the first stage with a note on it.
    moveTo(state.component, "Add note");
    enter(state.component);
    state.component.handleInput("budget is fixed this quarter");
    enter(state.component);
    moveTo(state.component, "A");
    enter(state.component);
    // Answering the stage moved the cursor on to the next unresolved one.
    assert.match(text(state.component), /Pick two/, "the second stage is current after the first is answered");
    moveTo(state.component, "C");
    enter(state.component);
    // With every stage answered the wizard is already on the review tab.
    assert.match(text(state.component), /Review your answers/, "approving is offered once nothing is outstanding");
    assert.match(text(state.component), /Add global note/, "the review tab has a global-note row");
    moveTo(state.component, "Add global note");
    enter(state.component);
    assert.match(text(state.component), /Add a global note:/);
    state.component.handleInput("go with the cheaper option");
    enter(state.component);
    moveTo(state.component, "Approve review");
    enter(state.component);

    assert.equal(state.result?.status, "completed");
    assert.equal(state.result?.answers.find((answer) => answer.stageId === "one")?.notes, "budget is fixed this quarter");
    assert.equal(state.result?.globalNote, "go with the cheaper option");
    const envelope = buildResponse(state.result, state.review).content[0].text;
    assert.match(envelope, /budget is fixed this quarter/, "the per-stage note reaches the model");
    assert.match(envelope, /go with the cheaper option/, "and so does the global note");
    state.component.dispose();
  });

  it("a note never answers the stage on its own", () => {
    const { component } = build();
    moveTo(component, "Add note");
    enter(component);
    component.handleInput("just a note");
    enter(component);
    assert.doesNotMatch(text(component), /Current answer:/, "attaching a note is not answering");
    component.dispose();
  });
});

/**
 * The stacked layout must never trade the picture for the fit.
 *
 * The artwork is the one elastic part of the frame, so when pi-tui's aspect
 * arithmetic hands back more rows than the budget allowed the excess comes out
 * of the padding. Cutting by position instead took the iTerm2 escape with it -
 * it is the artwork's *last* line - and the image count went from one to none
 * while the test suite stayed green.
 */
describe("stacked layout: the picture survives the fit", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  it("trims padding, never the escape, on both protocols", async () => {
    const { parseITerm2, parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { fileURLToPath } = await import("node:url");
    const fixture = fileURLToPath(new URL("./fixtures/tui-smoke.png", import.meta.url));
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      for (const protocol of ["kitty", "iterm2"]) {
        const previous = setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
        try {
          const review = normalizeReview({
            images: "on",
            reviewId: `fit-${protocol}`,
            stages: [{ id: "one", header: "One", prompt: "Pick", options: [
              { id: "a", label: "A", image: { path: fixture } },
              { id: "b", label: "B", image: { path: fixture } },
            ] }],
          });
          let result;
          // A short terminal on purpose: the frame cannot fit, so the fit logic
          // has to do real work.
          const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 20 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
          assert.ok(component.loadedImages.size > 0, `${protocol}: the image must load`);
          const frame = component.render(100).join("\r\n");
          component.dispose();
          const parsed = protocol === "kitty" ? parseKitty(frame).images : parseITerm2(frame).images;
          assert.equal(parsed.length, 1, `${protocol}: the artwork is still there after the fit`);
          assert.ok(!parsed[0].more, `${protocol}: and the transmission is complete`);
          assert.deepEqual(
            Buffer.from(parsed[0].payload, "base64"),
            readFileSync(fixture),
            `${protocol}: every byte of the image survives`,
          );
        } finally {
          if (previous) setCapabilities(previous);
        }
      }
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });
});

/**
 * The dialogue layout: the artwork is the scene, the information sits over it,
 * and the choices are one line each along the bottom.
 *
 * Descriptions under every row doubled the list's height and pushed the picture
 * off the top of the screen; the information now follows the cursor, which is
 * the thing the reader is looking at.
 */
describe("dialogue layout: one line per choice, information over the artwork", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  it("the footer names the question, the highlighted option's sentence, and the menu", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { fileURLToPath } = await import("node:url");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
      const review = normalizeReview({
        images: "on",
        reviewId: "dialogue",
        stages: [{
          id: "one", header: "One", prompt: "Which treatment ships?",
          options: [
            { id: "a", label: "Transit airy", description: "Scans fastest; secondary states lose their badges.", image: { path: fixture, alt: "Fixture" } },
            { id: "b", label: "Transit split", description: "Cause beside remedy, at the cost of density.", image: { path: fixture, alt: "Fixture" } },
            { id: "c", label: "Transit dense", description: "Everything at once.", image: { path: fixture, alt: "Fixture" } },
          ],
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
      assert.ok(component.loadedImages.size > 0, "the image must load");
      const plain = () => component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
      const indexOf = (needle) => plain().findIndex((line) => line.includes(needle));

      // The highlighted option's sentence is on screen, the other two are not,
      // and it sits *above* the question: the bottom of the screen is the
      // decision, what it is about sits above it.
      const described = indexOf("Scans fastest");
      assert.ok(described >= 0, "the highlighted option's sentence is shown");
      assert.equal(plain().some((line) => line.includes("Cause beside remedy")), false, "and only that one");
      assert.ok(described < indexOf("Which treatment ships?"), "the information is above the question");
      // The menu is one line per choice, with nothing printed under it.
      const airy = indexOf("1. Transit airy");
      assert.match(plain()[airy], /^\s*(> )?1\. Transit airy$/, "a choice is one row");
      assert.equal(plain()[airy + 1].includes("Scans fastest"), false, "and nothing is printed under it");
      assert.ok(indexOf("2. Transit split") === airy + 1, "the choices are consecutive");
      // The artwork is above the information, which is above the menu.
      const artAt = component.render(100).findIndex((line) => line.includes("\u001b_G"));
      const questionAt = indexOf("Which treatment ships?");
      assert.ok(artAt >= 0 && artAt < questionAt && questionAt < airy, "scene, then information, then the menu");
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * A stage whose option carries a drawn `mockup` is content, not text.
 *
 * `option.mockup` was accepted by the schema and then never drawn: a review
 * built out of mockups showed its questions and nothing else, and its preview
 * sat *below* the questions because the stacked layout keyed on images alone.
 */
describe("a missing image file is its own reason", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  it("names the file, not the host", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
        images: "on",
        reviewId: "missing",
        stages: [{ id: "one", header: "One", prompt: "Pick", options: [
          { id: "a", label: "A", description: "First.", image: { path: "/nowhere/missing.png" } },
          { id: "b", label: "B", description: "Second.", image: { path: "/nowhere/missing.png" } },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      await new Promise((r) => setTimeout(r, 300));
      const prose = component.render(110).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).join(" ").replace(/\s+/g, " ");
      assert.match(prose, /Image unavailable/, "a missing file is not a host that cannot draw");
      assert.doesNotMatch(prose, /tmux 3\.6a/, "and the message must not blame the multiplexer for a bad path");
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

describe("a drawn mockup fills the content area, with the questions under it", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  it("draws the mockup above the question and the menu", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
        reviewId: "mockup-stage",
        stages: [{
          id: "one", header: "Creatures", prompt: "What does that mean concretely?",
          options: [
            { id: "a", label: "Farm animals plus one night predator", description: "Two new entity types.", mockup: {
              layout: "list",
              header: "NEW ENTITIES",
              rows: [
                { label: "cow, sheep", detail: "graze by day" },
                { label: "nightstalker", detail: "spawns at night" },
              ],
            } },
            { id: "b", label: "Farm animals only", description: "No predator." },
          ],
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const frame = component.render(100);
      const plain = frame.map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
      const artAt = frame.findIndex((line) => line.includes("\u001b_G"));
      const questionAt = plain.findIndex((line) => line.includes("What does that mean concretely?"));
      const menuAt = plain.findIndex((line) => line.includes("1. Farm animals"));
      assert.ok(artAt >= 0, "the mockup is drawn, not left as an accepted-but-unused field");
      assert.ok(artAt < questionAt, "above the question");
      assert.ok(questionAt < menuAt, "and the questions are under it");
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * When the host cannot draw a picture, the frame must read as a questionnaire
 * with a reason, not as a panel with a placeholder in it.
 *
 * pi-tui's own fallback is a single bracketed "[Image: path ...]" line, which
 * explains nothing and used to occupy the content area on its own. The wizard
 * recognises it (a render with no graphics escape in it) and speaks for itself:
 * what was detected, why, and what to run.
 */
describe("a host that cannot draw says so in the content area", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  it("replaces the placeholder with the reason, and keeps the layout", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      // A real image: this case is the *host*, not a broken path.
      const image = fileURLToPath(new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url));
      const review = normalizeReview({
        images: "on",
        reviewId: "no-host",
        stages: [{ id: "layout", header: "Layout", prompt: "Which treatment ships?", options: [
          { id: "a", label: "Transit airy", description: "Scans fastest.", image: { path: image, alt: "treatment" } },
          { id: "b", label: "Transit split", description: "Route beside action.", image: { path: image, alt: "treatment" } },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      await new Promise((r) => setTimeout(r, 300));
      const frame = component.render(110);
      const prose = frame.map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).join(" ").replace(/\s+/g, " ");
      assert.doesNotMatch(prose, /\[Image:/, "the renderer placeholder is not the explanation");
      assert.doesNotMatch(prose, /file:\/\//, "and the path is not printed twice");
      assert.match(prose, /images are off/i, "the reason is on screen, where the picture would be");
      assert.match(prose, /run pi outside tmux/i, "along with what actually works");
      // The picture's alt text still carries the content for a host that cannot show it.
      assert.match(prose, /Alt: treatment/, "and the image's own description is not lost");
      // The menu is still one line per choice, right under the question.
      const rows = frame.map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
      const first = rows.findIndex((line) => /1\. Transit airy/.test(line));
      assert.ok(first >= 0, "the choices are on screen");
      assert.doesNotMatch(rows[first + 1] ?? "", /Scans fastest/, "and nothing is printed under a choice");
      component.dispose();
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previous) setCapabilities(previous);
    }
  });
});
