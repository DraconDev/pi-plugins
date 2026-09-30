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
      // Comfortable prints a reason under *every* choice, so one per option is
      // the count, and no reason is repeated above the question.
      const reasons = rows.filter((line) => /Favors quick orientation|Favors balanced context/.test(line)).length;
      assert.equal(reasons, 2, "one reason per option, and no second copy above the question");
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
      assert.match(prose, /pictures are off/i, "a host that cannot render pictures must say so");
      assert.match(prose, /run pi outside tmux|tmux 3\.6a strips/i, "and say what actually works");
      assert.match(prose, /run Pi outside tmux|tmux 3\.6a strips/i, "and names what actually works");
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

      // Comfortable is the default: a reason under every choice, and the reason
      // appears exactly once - the panel must not say the same sentence twice.
      const airy = indexOf("1. Transit airy");
      assert.match(plain()[airy], /^\s*(> )?1\. Transit airy$/, "a choice is one row");
      const reasons = plain().filter((line) => /Scans fastest|Cause beside remedy/.test(line));
      assert.equal(reasons.length, 2, "one reason per option, and no second copy above the question");
      assert.ok(reasons.some((line) => line.includes("Scans fastest")), "the highlighted option's reason is on screen");
      assert.ok(indexOf("Which treatment ships?") < airy, "and the question is above the list");
      // Compact is where the information moves above the question; its own
      // ordering is asserted in the density suite below.
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
      assert.match(prose, /pictures are off/i, "the reason is on screen, where the picture would be");
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

/**
 * The content area carries the option's own change list.
 *
 * No picture, no drawing: what a reviewer reads there is what the option would
 * change, one item per line. It is the answer to "we are not using the space
 * fully" that does not put decoration in it.
 */
describe("content area: the option's changes, in plain text", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const withChanges = () => {
    const review = normalizeReview({
      reviewId: "changes",
      stages: [{
        id: "one", header: "One", prompt: "Which treatment?",
        options: [
          { id: "a", label: "Three-row queue", description: "Scans fastest.", changes: [
            "One row per state, so a delayed route is visible without scrolling",
            "Capacity moves into the row, and the secondary badges go",
            "Keyboard: ↑↓ walks rows instead of tabs",
          ] },
          { id: "b", label: "Two-column split", description: "Denser.", changes: ["Delay beside the action", "Wider rows, fewer fit on screen"] },
          { id: "c", label: "No change", description: "Leave it." },
        ],
      }],
    });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    return { component, review, get result() { return result; } };
  };
  const frame = (component) => component.render(100);
  const prose = (component) => frame(component).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).join("\n");

  it("renders each change as its own line, above the question", () => {
    const { component } = withChanges();
    const text = prose(component);
    assert.match(text, /This option changes:/, "the list says what it is");
    assert.match(text, /• One row per state, so a delayed route is visible without scrolling/, "the first change, in full");
    assert.match(text, /• Keyboard: ↑↓ walks rows instead of tabs/, "the last change");
    const changesAt = frame(component).findIndex((line) => line.includes("This option changes:"));
    const questionAt = frame(component).findIndex((line) => line.includes("Which treatment?"));
    const menuAt = frame(component).findIndex((line) => line.includes("1. Three-row queue"));
    assert.ok(changesAt >= 0 && changesAt < questionAt, "the changes are above the question");
    assert.ok(questionAt < menuAt, "and the question is above the answers");
    component.dispose();
  });

  it("follows the cursor: another option shows its own changes", () => {
    const { component } = withChanges();
    component.handleInput("\u001b[B");
    const text = prose(component);
    assert.match(text, /• Delay beside the action/, "the second option's changes");
    assert.equal(text.includes("One row per state"), false, "and not the first option's");
    component.dispose();
  });

  it("an option with nothing to show says so instead of padding the block", () => {
    const { component } = withChanges();
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    const text = prose(component);
    assert.equal(text.includes("This option changes:"), false, "no change list is claimed");
    assert.equal(text.includes("No change"), true, "the question and its options are still there");
    component.dispose();
  });
});

/**
 * Density is a setting, not a habit.
 *
 * Comfortable is what the panel has always done: a reason under every choice.
 * Compact lists the choices alone and shows the highlighted option's reason
 * once, above the question. The review seeds it, Ctrl+D flips it, the footer
 * always says which one is in force, and the choice is remembered across rounds.
 */
describe("density: comfortable by default, compact on request, Ctrl+D either way", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const eightOptions = (extra = {}) => normalizeReview({
    reviewId: "density",
    title: "Which treatment?",
    ...extra,
    stages: [{
      id: "one", header: "Treatment", prompt: "Which treatment ships first?",
      options: Array.from({ length: 8 }, (_, index) => ({
        id: `o${index}`, label: `Option ${index + 1}`, description: `Reason number ${index + 1}, long enough to matter on its own line.`,
      })),
    }],
  });
  const build = (review) => {
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    return { component, review, get result() { return result; } };
  };
  const rows = (component) => component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  const prose = (component) => rows(component).join(" ").replace(/\s+/g, " ");
  const isChoice = (line) => /^\s*>?\s*\d+\.\s+Option \d+\s*$/.test(line);
  const reasonOf = (line) => /Reason number (\d+)/.exec(line)?.[1];

  it("comfortable is the default: a reason under every choice", () => {
    const { component, review } = build(eightOptions());
    assert.equal(review.density, "comfortable", "the default is unchanged behaviour");
    const lines = rows(component);
    for (let index = 1; index <= 8; index += 1) {
      const at = lines.findIndex((line) => isChoice(line) && line.includes(`Option ${index}`));
      assert.ok(at >= 0, `option ${index} is listed`);
      assert.equal(reasonOf(lines[at + 1] ?? ""), String(index), `option ${index} has its own reason beneath it`);
    }
    component.dispose();
  });

  it("compact lists the choices alone and shows one reason, above the question", () => {
    const { component, review } = build(eightOptions({ density: "compact" }));
    assert.equal(review.density, "compact");
    const lines = rows(component);
    assert.equal(lines.filter(isChoice).length, 8, "all eight options, one row each");
    const reasons = lines.filter((line) => reasonOf(line));
    assert.equal(reasons.length, 1, "exactly one reason on screen");
    assert.equal(reasonOf(reasons[0]), "1", "and it is the highlighted option's");
    const reasonAt = lines.indexOf(reasons[0]);
    const firstChoiceAt = lines.findIndex(isChoice);
    assert.ok(reasonAt >= 0 && reasonAt < firstChoiceAt, "the highlighted reason leads the list");
    component.dispose();
  });

  it("compact spends fewer rows on the same options than comfortable", () => {
    const comfortable = build(eightOptions());
    const compact = build(eightOptions({ density: "compact" }));
    const filled = (component) => rows(component).filter((line) => line.trim()).length;
    assert.ok(filled(compact.component) < filled(comfortable.component), `compact is shorter: ${filled(compact.component)} vs ${filled(comfortable.component)} rows`);
    comfortable.component.dispose();
    compact.component.dispose();
  });

  it("Ctrl+D toggles both ways and the footer always names the mode", () => {
    const { component } = build(eightOptions());
    assert.match(prose(component), /density: comfortable/, "the default is stated");
    component.handleInput("\u0004");
    assert.match(prose(component), /density: compact/, "Ctrl+D switches to compact");
    assert.equal(rows(component).filter(isChoice).length, 8, "and the choices are one row each");
    component.handleInput("\u0004");
    assert.match(prose(component), /density: comfortable/, "Ctrl+D switches back");
    assert.equal(rows(component).filter((line) => reasonOf(line)).length, 8, "and the reasons are back under their choices");
    component.dispose();
  });

  it("the review's density is honoured, and the person can still override it", () => {
    const { component } = build(eightOptions({ density: "compact" }));
    assert.match(prose(component), /density: compact/, "the review's density is honoured");
    component.handleInput("\u0004");
    assert.match(prose(component), /density: comfortable/, "and Ctrl+D overrides it for the session");
    component.dispose();
  });
});

/**
 * The image layout is the one people actually see, and it used to be the one
 * layout that forgot the setting existed.
 *
 * The density line and the Ctrl+D hint were written out twice — once in the
 * plain layout, once in the stacked one — and the copies drifted, so a review
 * carrying a picture showed neither. These render an option with an image in
 * both modes, because "works in the layout the tests happen to use" is exactly
 * how that gap survived a green suite.
 */
describe("density in the image layout, where the picture is", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const imageReview = (extra = {}) => {
    const { fileURLToPath } = { fileURLToPath: (u) => new URL(u).pathname };
    return normalizeReview({
      reviewId: "image-density",
      images: "on",
      ...extra,
      stages: [{
        id: "one", header: "Treatment", prompt: "Which treatment ships first?",
        options: [
          { id: "a", label: "Transit airy", description: "One row per state; the secondary badges go.", image: { path: fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url)), alt: "Fixture" } },
          { id: "b", label: "Transit split", description: "Delay beside the action; denser to scan.", image: { path: fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url)), alt: "Fixture" } },
        ],
      }],
    });
  };
  const build = async (review) => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
    assert.ok(component.loadedImages.size > 0, "the image must load or this layout is not the one under test");
    if (previous) setCapabilities(previous);
    return { component, get result() { return result; } };
  };
  const lines = (component) => component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
  const prose = (component) => lines(component).join(" ").replace(/\s+/g, " ");
  const isChoice = (line) => /^\s*>?\s*\d+\.\s+Transit/.test(line);
  const artAt = (component) => component.render(100).findIndex((line) => line.includes("\u001b_G"));

  it("names the density and the shortcut, beside the auto-resolve line, in both modes", async () => {
    for (const [mode, expected] of [["comfortable", /density: comfortable/], ["compact", /density: compact/]]) {
      const { component } = await build(imageReview(mode === "compact" ? { density: "compact" } : {}));
      const text = prose(component);
      assert.match(text, expected, `${mode}: the mode is stated in the image layout`);
      assert.match(text, /auto-resolve:/, `${mode}: beside the auto-resolve line`);
      assert.match(text, /Ctrl\+D density/, `${mode}: the key hints name the shortcut`);
      assert.ok(artAt(component) >= 0, `${mode}: and this really is the image layout`);
      component.dispose();
    }
  });

  it("compact renders the choice alone and puts the reason in the content area", async () => {
    const { component } = await build(imageReview({ density: "compact" }));
    const text = lines(component);
    const airy = text.findIndex((line) => isChoice(line) && line.includes("Transit airy"));
    assert.ok(airy >= 0, "the choice is listed");
    assert.equal(text.filter(isChoice).length, 2, "both choices, one row each");
    const reasons = text.filter((line) => /One row per state|secondary badges go|Delay beside the action/.test(line));
    assert.equal(reasons.length, 1, "exactly one reason on screen");
    assert.match(reasons[0], /One row per state/, "and it is the highlighted option's");
    // The content area is the band between the artwork and the question.
    const art = artAt(component);
    const question = text.findIndex((line) => line.includes("Which treatment ships first?"));
    const reasonAt = text.indexOf(reasons[0]);
    assert.ok(art >= 0 && art < reasonAt, "the reason sits below the picture");
    assert.ok(reasonAt < question, "and above the question, inside the content area");
    component.dispose();
  });

  it("comfortable still prints a reason under every choice, with the picture", async () => {
    const { component } = await build(imageReview());
    const text = lines(component);
    // A seam can sit between a choice and its reason, so the reason is looked
    // for from the choice rather than assumed to be the very next line.
    const reasonAfter = (label) => {
      const at = text.findIndex((line) => isChoice(line) && line.includes(label));
      assert.ok(at >= 0, `${label} is listed`);
      return text.slice(at + 1, at + 4).join(" ");
    };
    assert.match(reasonAfter("Transit airy"), /secondary badges go/, "the reason is under its own choice");
    assert.match(reasonAfter("Transit split"), /Delay beside the action/, "for every choice, not only the highlighted one");
    component.dispose();
  });
});

/**
 * The regression the last round shipped, pinned.
 *
 * Rendering a reason under every choice doubled the height of the default
 * mode's choice band, which tipped 8–10 options into a short-panel fallback
 * whose body read the array it had just cleared — so the whole footer tail
 * vanished: the key hints, the auto-resolve line, the density line and the
 * closing rule. Every image-layout density test used **two** options, which is
 * exactly the size that still fits, so a green suite proved nothing about it.
 *
 * These render 8 and 10 options with a picture, in both modes, at the heights
 * the object names.
 */
describe("the footer survives a long option list, with the picture", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const fixture = new URL("./fixtures/tiny.png", import.meta.url).pathname;
  const build = async (extra, options, rows) => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    const review = normalizeReview({
      reviewId: "long", images: "on", ...extra,
      stages: [{
        id: "one", header: "Treatment", prompt: "Which treatment ships first?",
        options: Array.from({ length: options }, (_, index) => ({
          id: `o${index}`, label: `Option ${index + 1}`,
          description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
          image: { path: fixture, alt: "Fixture" },
        })),
      }],
    });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
    if (previous) setCapabilities(previous);
    const text = component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    return { component, text, get result() { return result; } };
  };

  for (const options of [8, 10]) {
    for (const rows of [40, 44]) {
      it(`keeps the hints, auto-resolve, density and the closing rule at ${options} options, ${rows} rows, comfortable`, async () => {
        const { component, text } = await build({}, options, rows);
        const joined = text.join("\n");
        assert.match(joined, /↑↓ move/, "the key hints are still on screen");
        assert.match(joined, /auto-resolve: /, "the auto-resolve line is still on screen");
        assert.match(joined, /density: /, "and so is the mode");
        assert.match(text[text.length - 1], /^─+$/, "the frame is closed by its rule");
        component.dispose();
      });
      it(`keeps the same four at ${options} options, ${rows} rows, compact`, async () => {
        const { component, text } = await build({ density: "compact" }, options, rows);
        const joined = text.join("\n");
        assert.match(joined, /density: compact/, "the mode is stated");
        assert.match(joined, /auto-resolve: /, "the auto-resolve line is still on screen");
        assert.match(text[text.length - 1], /^─+$/, "the frame is closed by its rule");
        component.dispose();
      });
    }
  }

  it("stays inside the fixed panel instead of spilling into the host's rows", async () => {
    for (const options of [8, 11, 14]) {
      for (const rows of [36, 40, 44]) {
        const { component, text } = await build({}, options, rows);
        // PANEL_MAX_ROWS is 32 and five rows belong to the host.
        assert.ok(text.length <= 32, `${options} options at ${rows} rows stays in the panel (got ${text.length})`);
        assert.ok(text.length <= rows - 5 + 1, `${options} options at ${rows} rows leaves the host's rows alone (got ${text.length})`);
        component.dispose();
      }
    }
  });
});

/**
 * The picture has to be a picture.
 *
 * A render with no graphics escape in it is a fallback, and a Kitty escape
 * with a two-cell box is a picture you cannot judge a dashboard treatment from
 * - which is exactly what the default mode produced at eight options while every
 * test stayed green, because they asserted `r > 0 && c > 0` and a 2x1 sliver
 * passes that. These read the cell box out of the escape itself.
 */
describe("the artwork keeps a reviewable size at every option count", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  // The real 1024x1024 benchmark image, not the 16x16 fixture: a sliver only
  // shows up on a picture with real proportions.
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;
  const MIN_REVIEWABLE = 6; // MIN_ART_ROWS

  const boxFor = async (options, density, rows) => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
        reviewId: "art", images: "on", ...(density === "compact" ? { density } : {}),
        stages: [{
          id: "one", header: "Treatment", prompt: "Which treatment ships first?",
          options: Array.from({ length: options }, (_, index) => ({
            id: `o${index}`, label: `Option ${index + 1}`,
            description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
            image: { path: image, alt: "Fixture" },
          })),
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 50));
      assert.ok(component.loadedImages.size > 0, "the image must load or this proves nothing");
      const frame = component.render(110).join("\n");
      component.dispose();
      const { images } = parseKitty(frame);
      assert.equal(images.length, 1, "exactly one inline image");
      return { columns: Number(images[0].keys.c), rows: Number(images[0].keys.r), frame: frame.split("\n").length };
    } finally {
      if (previous) setCapabilities(previous);
    }
  };

  for (const options of [2, 8, 10, 14, 20]) {
    for (const density of ["comfortable", "compact"]) {
      it(`draws a reviewable picture at ${options} options, ${density}`, async () => {
        const { columns, rows } = await boxFor(options, density, 44);
        assert.ok(
          rows >= MIN_REVIEWABLE || columns >= 12,
          `${options} options ${density}: the picture is ${columns}x${rows} cells, which is a sliver rather than a preview`,
        );
      }, { timeout: 30000 });
    }
  }

  it("says so when the reasons were dropped, rather than claiming they are there", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const options = Array.from({ length: 20 }, (_, index) => ({
        id: `o${index}`, label: `Option ${index + 1}`,
        description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
        image: { path: image, alt: "Fixture" },
      }));
      const review = normalizeReview({
        reviewId: "copy", images: "on",
        stages: [{ id: "one", header: "T", prompt: "Which ships?", options }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 50));
      const prose = component.render(110).join(" ").replace(/\s+/g, " ");
      component.dispose();
      assert.match(prose, /density: comfortable/, "the mode is still stated");
      assert.doesNotMatch(
        prose,
        /a reason under every choice/,
        "and it does not claim reasons the frame had to drop to keep the picture",
      );
    } finally {
      if (previous) setCapabilities(previous);
    }
  }, { timeout: 30000 });
});

/**
 * Every option is reachable, and visibly so.
 *
 * The band-truncation loop that preceded this dropped whole choices out of the
 * rendered rows to keep the picture big. The consequence was worse than a long
 * list: pressing `↓` past the tenth row moved the cursor onto an option that
 * was never drawn and never carried the `>` marker, and `Enter` recorded it. A
 * review that can be answered with a choice the person never saw is not a dense
 * review, it is a wrong one - so the band is now a window that scrolls, and
 * these walk the entire list and check that every option is marked on screen at
 * the moment the cursor is on it.
 */
describe("every option is reachable and marked, at every length", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;

  const walk = async (options, density) => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
        reviewId: "reach", images: "on", ...(density === "compact" ? { density } : {}),
        stages: [{
          id: "one", header: "Treatment", prompt: "Which treatment ships first?",
          options: Array.from({ length: options }, (_, index) => ({
            id: `o${index}`, label: `Option ${index + 1}`,
            description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
            image: { path: image, alt: "Fixture" },
          })),
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 50));
      assert.ok(component.loadedImages.size > 0, "the image must load");
      const markedWhileWalking = new Set();
      let sawOverflowMarker = false;
      for (let index = 0; index < options; index += 1) {
        const frame = component.render(100);
        const plain = frame.map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
        for (const line of plain) {
          const match = /^\s*> \d+\. (Option \d+)$/.exec(line);
          if (match) markedWhileWalking.add(match[1]);
        }
        if (/[↑↓]\s*\d+\s+more/.test(plain.join("\n"))) sawOverflowMarker = true;
        if (index < options - 1) component.handleInput("\u001b[B");
      }
      // Answer the option the cursor ended on, then read what the review
      // recorded. Answering moves the cursor to the review tab, whose summary is
      // where the recorded answer is visible before the review is submitted.
      component.handleInput("\r");
      const reviewTab = component.render(100).join(" ");
      component.handleInput("\r"); // approve from the review tab
      const recorded = result?.answers?.find((answer) => answer.stageId === "one")?.answer;
      component.dispose();
      return { markedWhileWalking, sawOverflowMarker, recorded, reviewTab };
    } finally {
      if (previous) setCapabilities(previous);
    }
  };

  for (const options of [8, 14, 20]) {
    for (const density of ["comfortable", "compact"]) {
      it(`shows and marks every one of ${options} options, ${density}`, async () => {
        const { markedWhileWalking, recorded } = await walk(options, density);
        assert.equal(
          markedWhileWalking.size,
          options,
          `${options} options ${density}: only ${markedWhileWalking.size} were ever marked on screen`,
        );
        assert.equal(recorded, `Option ${options}`, "and the answer is the option the cursor was on");
      }, { timeout: 30000 });
    }
  }

  it("signposts that the list scrolls rather than pretending it ended", async () => {
    const { sawOverflowMarker } = await walk(20, "comfortable");
    assert.equal(sawOverflowMarker, true, "a band that scrolls says so with ↑ n more / ↓ n more");
  }, { timeout: 30000 });

  it("does not claim to scroll when everything fits", async () => {
    const { sawOverflowMarker } = await walk(8, "comfortable");
    assert.equal(sawOverflowMarker, false, "eight options fit, so there is nothing to scroll to");
  }, { timeout: 30000 });
});

/**
 * The band window, across the content a review actually carries.
 *
 * The reachability cases above all put an `image` on every option, which is the
 * one layout that happened to work. A stage whose content is a `preview` or a
 * `changes` list renders different rows - and a multi-select row is a checkbox,
 * not a number - so the window has to recognise the shapes that are really
 * rendered. When it did not, the first frame came up with no cursor marker at
 * all and the person could answer with an option nobody had seen.
 *
 * These walk the list **by option**, advancing until the marked option changes,
 * because a band that carries reasons moves more than one row per keypress and
 * counting keypresses overshoots the end.
 */
describe("the band window, for every kind of content a review carries", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;

  const optionFor = (component) => {
    const plain = component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    // The cursor marker, whichever shape the row has: "1. Option 3" or "[ ] Option 3".
    const marked = plain.find((line) => /^\s*>\s*(?:\d+\.\s+|\[[ x]\]\s+)Option (\d+)\s*$/.exec(line));
    return marked ? Number(/Option (\d+)/.exec(marked)[1]) : 0;
  };

  const walk = async (content, { options: count, multiSelect, density, rows }) => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const build = (base) => content === "image" ? { ...base, image: { path: image, alt: "Fixture" } }
        : content === "preview" ? { ...base, preview: "a short preview block" }
        : { ...base, changes: [`change one for ${base.label}`, "change two"] };
      const review = normalizeReview({
        reviewId: "window", images: "on", ...(density === "compact" ? { density } : {}),
        stages: [{
          id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
          options: Array.from({ length: count }, (_, index) => build({
            id: `o${index}`, label: `Option ${index + 1}`,
            description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
          })),
        }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0 && content === "image") await new Promise((r) => setTimeout(r, 50));
      const seen = new Set([optionFor(component)]);
      let current = [...seen][0];
      assert.ok(current > 0, "the first option is marked on the very first frame");
      for (let step = 1; step < count; step += 1) {
        let advanced = false;
        for (let guard = 0; guard < 8 && !advanced; guard += 1) {
          component.handleInput("\u001b[B");
          const now = optionFor(component);
          if (now !== current) { current = now; advanced = true; }
        }
        assert.ok(advanced, `↓ reaches the option after ${current}`);
        seen.add(current);
      }
      component.dispose();
      return seen;
    } finally {
      if (previous) setCapabilities(previous);
    }
  };

  for (const content of ["image", "preview", "changes"]) {
    for (const multiSelect of [false, true]) {
      for (const density of ["comfortable", "compact"]) {
        it(`marks every option with ${content} content, multiSelect=${multiSelect}, ${density}`, async () => {
          const seen = await walk(content, { options: 20, multiSelect, density, rows: 44 });
          assert.equal(seen.size, 20, `every option was marked on screen: ${[...seen].join(",")}`);
        }, { timeout: 30000 });
      }
    }
  }

  it("holds on a short terminal, where the panel cannot fit the list", async () => {
    const seen = await walk("changes", { options: 20, multiSelect: true, density: "comfortable", rows: 30 });
    assert.equal(seen.size, 20, "a cramped panel scrolls the band rather than losing options");
  }, { timeout: 30000 });
});

/**
 * The invariant behind all of it: a review never answers on a row the person
 * could not see.
 *
 * The reachability cases above check the *screens* - every option is marked as
 * the cursor walks past it. This checks the *answer*: whatever the review records
 * is the option that carried the marker in the frame immediately before Enter,
 * in every layout and every content type. Stated once, it holds for layouts
 * nobody thought to enumerate, and a future one cannot answer on an unseen row
 * without failing here.
 *
 * Each case answers the way the hints on screen say to. A single-select stage
 * commits the marked option on Enter. A multi-select stage checks it with Space
 * and commits on the explicit "Done selecting" row, because Enter on an option
 * is a toggle there and does not answer; the earlier version of this suite
 * pressed Enter twice, which left `result` undefined and compared
 * "(nothing recorded)" with "(nothing recorded)" - it could not fail.
 */
describe("a review only ever answers on an option it just showed", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;

  for (const content of ["image", "preview", "changes"]) {
    for (const multiSelect of [false, true]) {
      for (const density of ["comfortable", "compact"]) {
        it(`${content} / multiSelect=${multiSelect} / ${density}: the answer is the option that was marked`, async () => {
          const { setCapabilities } = await import("@earendil-works/pi-tui");
          const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
          try {
            const count = 20;
            const build = (base) => content === "image" ? { ...base, image: { path: image, alt: "Fixture" } }
              : content === "preview" ? { ...base, preview: "a short preview block" }
              : { ...base, changes: [`change one for ${base.label}`, "change two"] };
            const review = normalizeReview({
              reviewId: "answer", images: "on", ...(density === "compact" ? { density } : {}),
              stages: [{
                id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
                options: Array.from({ length: count }, (_, index) => build({
                  id: `o${index}`, label: `Option ${index + 1}`,
                  description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
                })),
              }],
            });
            let result;
            const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && component.loadedImages.size === 0 && content === "image") await new Promise((r) => setTimeout(r, 50));

            const plain = () => component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
            const marked = () => {
              const line = plain().find((entry) => /^\s*>\s*(?:\d+\.\s+|\[[ x]\]\s+)Option (\d+)\s*$/.exec(entry));
              return line ? Number(/Option (\d+)/.exec(line)[1]) : 0;
            };
            // The commit row is a numbered choice too, so it carries a number.
            const onDoneRow = () => plain().some((entry) => /^\s*>\s*(?:\d+\.\s+)?Done selecting\s*$/.test(entry));

            // Walk to the middle of the list, one option at a time.
            let shown = marked();
            for (let step = 1; step < 12; step += 1) {
              for (let guard = 0; guard < 8; guard += 1) {
                component.handleInput("\u001b[B");
                const now = marked();
                if (now !== shown) { shown = now; break; }
              }
            }
            assert.ok(shown > 0, "an option is marked before Enter");

            // The frame the person is looking at, immediately before the keystroke.
            const frameBefore = plain();
            assert.ok(
              frameBefore.some((line) => new RegExp(`^\\s*>\\s*(?:\\d+\\.\\s+|\\[[ x]\\]\\s+)Option ${shown}\\s*$`).test(line)),
              `option ${shown} is marked in the frame the person is looking at`,
            );

            if (multiSelect) {
              // Check it, then commit on the row the hints name.
              component.handleInput(" ");
              const checked = plain().find((entry) => new RegExp(`^\\s*>\\s*\\[x\\]\\s+Option ${shown}\\s*$`).test(entry));
              assert.ok(checked, `option ${shown} is checked, and the check is on screen`);
              for (let step = 0; step < count + 2 && !onDoneRow(); step += 1) component.handleInput("\u001b[B");
              assert.ok(onDoneRow(), "the Done selecting row can be reached");
              component.handleInput("\r");
            } else {
              component.handleInput("\r");
            }
            // Answering the question is not finishing the review: it moves to the
            // approval row, and the review completes when that is confirmed.
            component.handleInput("\r");

            const recorded = result?.answers?.find((answer) => answer.stageId === "one");
            assert.ok(recorded, "the review completed and recorded an answer for the stage");
            assert.deepEqual(
              recorded.optionLabels,
              [`Option ${shown}`],
              `the review recorded exactly the option that was marked on screen (${shown})`,
            );
            component.dispose();
          } finally {
            if (previous) setCapabilities(previous);
          }
        }, { timeout: 30000 });
      }
    }
  }
});

/**
 * The answer is an option that was on screen, wherever the answer is taken.
 *
 * The suite above checks the invariant at one cursor position per layout, which
 * is a spot check: a layout that answers correctly on option 12 and wrongly on
 * option 3 - or on the last one, or after the list has wrapped - passes it. This
 * answers from four positions in every layout, because the interesting failures
 * are at the edges. Walking to the end and then past it wraps the cursor round,
 * and the band has to come back with it.
 *
 * "Appeared, with its marker" is also checked as a history and not only as a
 * snapshot, because the two forms of the rule are not the same. Single-select
 * commits on the option's own row, so the frame immediately before Enter must
 * carry the marker on the option that gets recorded - the literal form. A
 * multi-select stage commits on a separate "Done selecting" row, so the frame
 * before the commit keystroke is that row and cannot carry the option's marker
 * at all; there the honest requirement is that every option the review records
 * appeared carrying its marker in some frame *before* the commit, and that is
 * what is asserted.
 */
describe("the answer is an option that was on screen, at every position in the list", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;

  const POSITIONS = [
    { name: "the first option", downs: 0 },
    { name: "an option in the middle", downs: 5 },
    { name: "the last option", downs: Number.POSITIVE_INFINITY },
    { name: "the first option again, after wrapping", downs: Number.POSITIVE_INFINITY, wrap: true },
  ];

  for (const content of ["image", "preview", "changes"]) {
    for (const multiSelect of [false, true]) {
      for (const density of ["comfortable", "compact"]) {
        for (const position of POSITIONS) {
          it(`${content} / multiSelect=${multiSelect} / ${density} / answering from ${position.name}`, async () => {
            const { setCapabilities } = await import("@earendil-works/pi-tui");
            const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
            try {
              const count = 20;
              const build = (base) => content === "image" ? { ...base, image: { path: image, alt: "Fixture" } }
                : content === "preview" ? { ...base, preview: "a short preview block" }
                : { ...base, changes: [`change one for ${base.label}`, "change two"] };
              const review = normalizeReview({
                reviewId: "answer", images: "on", ...(density === "compact" ? { density } : {}),
                stages: [{
                  id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
                  options: Array.from({ length: count }, (_, index) => build({
                    id: `o${index}`, label: `Option ${index + 1}`,
                    description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
                  })),
                }],
              });
              let result;
              const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline && component.loadedImages.size === 0 && content === "image") await new Promise((r) => setTimeout(r, 50));

              const plain = () => component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
              const markedOption = () => {
                const line = plain().find((entry) => /^\s*>\s*(?:\d+\.\s+|\[[ x]\]\s+)Option (\d+)\s*$/.exec(entry));
                return line ? Number(/Option (\d+)/.exec(line)[1]) : 0;
              };
              const onDoneRow = () => plain().some((entry) => /^\s*>\s*(?:\d+\.\s+)?Done selecting\s*$/.test(entry));

              // Every option that has ever carried the marker, in this walk.
              // This is the history the multi-select rule is stated against.
              const appearedMarked = new Set();

              // Walk to the position, recording each marked option on the way.
              let current = markedOption();
              if (current > 0) appearedMarked.add(current);
              const step = () => {
                component.handleInput("\u001b[B");
                const now = markedOption();
                if (now > 0) appearedMarked.add(now);
                return now;
              };
              if (position.downs === 0) {
                assert.ok(current > 0, "the first option carries the marker");
              } else if (position.downs === Number.POSITIVE_INFINITY) {
                // Down off the end of the options and onto the action rows, where
                // no option carries the marker. That is how the end of the list
                // is found: not by the marker repeating, but by it stopping.
                for (let down = 0; down < count + 4 && markedOption() > 0; down += 1) step();
                assert.equal(markedOption(), 0, "the walk reached the rows past the last option");
                if (position.wrap) {
                  // Round the whole list and come back to the top.
                  for (let down = 0; down < count * 2 + 6 && markedOption() !== 1; down += 1) step();
                } else {
                  // One row back onto the last option itself.
                  component.handleInput("\u001b[A");
                }
              } else {
                for (let down = 0; down < position.downs; down += 1) step();
              }
              assert.ok(markedOption() > 0, `an option carries the marker at ${position.name}`);

              if (multiSelect) {
                // Check the option under the cursor, then commit on the row the
                // hints name. The commit frame is that row, so the requirement
                // here is the history: it must have been on screen, marked.
                const checked = markedOption();
                component.handleInput(" ");
                assert.ok(
                  plain().some((entry) => new RegExp(`^\\s*>\\s*\\[x\\]\\s+Option ${checked}\\s*$`).test(entry)),
                  `option ${checked} is checked, and the check is on screen`,
                );
                for (let down = 0; down < count + 2 && !onDoneRow(); down += 1) component.handleInput("\u001b[B");
                assert.ok(onDoneRow(), "the Done selecting row can be reached");
                component.handleInput("\r");
                // Committing the selection answers the stage, it does not finish
                // the review: there is still the approval row to confirm, and a
                // test that assumed otherwise would be asserting nothing.
                assert.equal(result, undefined, "committing the selection has not finished the review yet");
                component.handleInput("\r");
                const answer = result?.answers?.find((entry) => entry.stageId === "one");
                assert.ok(answer, "the review completed and recorded an answer for the stage");
                for (const label of answer.optionLabels) {
                  const number = Number(/(\d+)$/.exec(label)?.[1]);
                  assert.ok(
                    appearedMarked.has(number),
                    `the recorded ${label} carried the marker in a frame before the commit (saw ${[...appearedMarked].join(",")})`,
                  );
                }
              } else {
                const shown = markedOption();
                const frameBefore = plain();
                assert.ok(
                  frameBefore.some((line) => new RegExp(`^\\s*>\\s*(?:\\d+\\.\\s+|\\[[ x]\\]\\s+)Option ${shown}\\s*$`).test(line)),
                  `option ${shown} is marked in the frame immediately before Enter`,
                );
                component.handleInput("\r");
                component.handleInput("\r");
                const answer = result?.answers?.find((entry) => entry.stageId === "one");
                assert.ok(answer, "the review completed and recorded an answer for the stage");
                assert.deepEqual(
                  answer.optionLabels,
                  [`Option ${shown}`],
                  `the review recorded exactly the option that carried the marker in the preceding frame (${shown})`,
                );
              }
              component.dispose();
            } finally {
              if (previous) setCapabilities(previous);
            }
          }, { timeout: 30000 });
        }
      }
    }
  }
});

/**
 * The scroll follows the cursor, in both directions.
 *
 * The scroll offset is the reader's place in the content, and the wheel moves it
 * on purpose. A keypress moves the *cursor*, and the frame has to follow it: a
 * long list is scrolled down, the person presses Up to go back, and if the frame
 * does not move the marker is no longer drawn - so Enter records an option that
 * was not on screen. That is the defect the whole change exists to prevent, and
 * it lived here: the offset was clamped but never pulled back to the cursor, and
 * the clip guard above could not help because by then the marker was not in the
 * frame to protect.
 */
describe("the cursor is never scrolled out of its own frame", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };

  const build = (options, multiSelect) => normalizeReview({
    reviewId: "scroll", images: "off",
    stages: [{
      id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
      options: Array.from({ length: options }, (_, index) => ({
        id: `o${index}`, label: `Option ${index + 1}`,
        description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
      })),
    }],
  });

  const marker = (component) => {
    const plain = component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    const line = plain.find((entry) => /^\s*>\s/.test(entry));
    return line ? line.trim() : "";
  };

  for (const multiSelect of [false, true]) {
    for (const rows of [44, 24]) {
      it(`keeps the cursor drawn after scrolling away and back, multiSelect=${multiSelect}, ${rows} rows`, async () => {
        const options = 20;
        const review = build(options, multiSelect);
        const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows } }, plainTheme, review, process.cwd(), () => {});
        const rowCount = component.currentRows().length;

        // Down to the very last row, so the frame is scrolled to the bottom.
        for (let step = 0; step < rowCount + 1; step += 1) component.handleInput("\u001b[B");
        assert.notEqual(marker(component), "", "a row is marked at the end of the list");

        // And back up to the first, which is the case that used to leave the
        // frame showing the bottom of the list with no marker anywhere on it.
        for (let step = 0; step < rowCount + 1; step += 1) component.handleInput("\u001b[A");
        const first = marker(component);
        assert.notEqual(first, "", "the first row is still marked after wrapping back to the top");
        assert.match(
          first,
          multiSelect ? /^\>\s\[[ x]\]\s+Option 1$/ : /^\>\s*\d+\.\s+Option 1$/,
          `the marker is on the first option, not left behind on the last one: ${JSON.stringify(first)}`,
        );
        component.dispose();
      }, { timeout: 30000 });
    }
  }
});

/**
 * The closing rule is not the row the frame gives up.
 *
 * The panel's bottom border is the last line of the frame, so anything that
 * assembles the frame a row too long takes the border with it. The window's
 * visible height and its two indicator lines are a fixed point - the indicators
 * depend on where the window sits, and the window's size depends on how many
 * indicators there are - and the code used to size the body from the scroll
 * offset *before* re-anchoring it on the cursor, then insert the indicators
 * from the settled offset. When the two disagreed, an extra "content above"
 * line went in after the body had been sized, the frame came out a row longer
 * than the terminal, and the border was the row that had to go. The two are now
 * resolved together, so the assembled frame is at most `height` rows by
 * construction, and the body gives up rows before the footer does.
 *
 * These cases are guards on that invariant rather than reproductions of a
 * specific loss: walking the list and jumping the cursor onto an unscrolled
 * frame did not make the old code lose the border in the shapes tried here, so
 * they pin the property rather than claim to catch a known failure.
 */
describe("the panel keeps its closing rule, whatever the scroll does", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const RULE = /^[─━═_-]{10,}$/;

  const review = ({ options, rows: _rows, multiSelect, recommended, autoResolve }) => normalizeReview({
    reviewId: "rule", images: "off", ...(autoResolve ? { autoResolve } : {}),
    stages: [{
      id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
      options: Array.from({ length: options }, (_, index) => ({
        id: `o${index}`, label: `Option ${index + 1}`,
        ...(index + 1 === recommended ? { recommended: true } : {}),
        description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
      })),
    }],
  });

  const frame = (component, width) => component.render(width)
    .map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));

  it("walks the whole list down and back up at 44 rows without losing the rule", async () => {
    for (const options of [8, 14, 20]) {
      for (const multiSelect of [false, true]) {
        const component = new VisualReviewWizard(
          { requestRender: () => {}, terminal: { rows: 44 } },
          plainTheme, review({ options, rows: 44, multiSelect }), process.cwd(), () => {},
        );
        const rowCount = component.currentRows().length;
        for (const key of ["\u001b[B", "\u001b[A"]) {
          for (let step = 0; step < rowCount + 2; step += 1) {
            component.handleInput(key);
            const lines = frame(component, 100);
            assert.ok(
              lines.some((line) => RULE.test(line.trim())),
              `${options} options, multiSelect=${multiSelect}, ${key === "\u001b[B" ? "down" : "up"} ${step + 1}: the panel's closing rule is still on screen`,
            );
            assert.ok(lines.length <= 44, `the frame fits the terminal: ${lines.length} lines`);
          }
        }
        component.dispose();
      }
    }
  }, { timeout: 30000 });

  it("keeps the rule when the cursor arrives on an unscrolled list", async () => {
    // Auto-resolve moves the cursor to the recommended option on the first
    // frame, while the scroll is still at the top - so the window has to leave
    // the top, and an indicator line has to appear above the body.
    for (const options of [8, 12, 20]) {
      for (const recommended of [options, options - 1, Math.max(2, Math.floor(options / 2))]) {
        for (const rows of [22, 24, 30]) {
          const component = new VisualReviewWizard(
            { requestRender: () => {}, terminal: { rows } },
            plainTheme, review({ options, rows, multiSelect: false, recommended, autoResolve: true }), process.cwd(), () => {},
          );
          const lines = frame(component, 100);
          assert.ok(
            lines.some((line) => RULE.test(line.trim())),
            `${options} options, recommended ${recommended}, ${rows} rows: the rule survived the jump`,
          );
          assert.ok(lines.length <= rows, `the frame fits: ${lines.length} of ${rows}`);
          component.dispose();
        }
      }
    }
  }, { timeout: 30000 });
});

/**
 * The wheel and the cursor each own their own thing.
 *
 * The scroll offset is the reader's place in the content, and the wheel moves
 * it on purpose - somebody reading a long list is looking at something other
 * than the row the cursor is on. So the wheel scrolls, and the frame stays
 * where they put it. A keypress moves the cursor, and then the frame follows,
 * because a frame that does not show where the cursor is is a frame where Enter
 * answers on a choice nobody was shown. The code used to re-anchor on every
 * render, so the two rules contradicted each other: a wheel that moved the
 * offset was pulled straight back to the cursor before anyone could read the
 * row it had just scrolled to. The rule is now decided by whether the cursor
 * moved, which is what this pins.
 */
describe("the wheel scrolls the content and the cursor still comes back to it", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };

  const wheel = (component, delta) => component.handleMouse({ type: "wheel", wheelDelta: delta, y: 0, x: 0, width: 100 });

  const optionsOnScreen = (component) => component.render(100)
    .map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""))
    .flatMap((line) => [...line.matchAll(/Option (\d+)/g)].map((match) => Number(match[1])));

  for (const rows of [44, 24]) {
    it(`the wheel moves the frame at ${rows} rows, and a keypress brings the cursor back`, async () => {
      const options = 20;
      const component = new VisualReviewWizard(
        { requestRender: () => {}, terminal: { rows } },
        plainTheme,
        normalizeReview({
          reviewId: "wheel", images: "off",
          stages: [{
            id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect: false,
            options: Array.from({ length: options }, (_, index) => ({
              id: `o${index}`, label: `Option ${index + 1}`,
              description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
            })),
          }],
        }),
        process.cwd(), () => {},
      );
      component.focused = true;
      component.render(100);

      const before = optionsOnScreen(component);
      assert.equal(before[0], 1, `the frame starts at the first option: ${before[0]}..${before.at(-1)}`);
      // A large delta, and asserted on where it lands rather than on "it
      // changed": re-anchoring on every render pinned the wheel to a single row
      // of travel, which is a dead control that still looks alive.
      wheel(component, 20);
      const scrolled = optionsOnScreen(component);
      assert.ok(
        scrolled[0] >= 5,
        `the wheel scrolls the content at ${rows} rows: ${before[0]}..${before.at(-1)} then ${scrolled[0]}..${scrolled.at(-1)}`,
      );
      assert.ok(
        scrolled.at(-1) > before.at(-1),
        `and keeps scrolling: ${before.at(-1)} then ${scrolled.at(-1)}`,
      );

      // The next cursor move takes the frame back to where the cursor is. Down
      // rather than up: the first row is the first option, and Up from there
      // wraps round to the revision row, which carries no option number.
      component.handleInput("\u001b[B");
      const marked = component.render(100)
        .map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""))
        .some((line) => /^\s*>\s*\d+\.\s+Option \d+\s*$/.test(line));
      assert.ok(marked, "after a cursor move the marked row is on screen again");
      component.dispose();
    }, { timeout: 30000 });
  }
});

/**
 * Every view of the review carries its footer tail.
 *
 * The panel pins four things at the bottom: the key hints, the auto-resolve
 * line, the density line and the closing rule. They are the controls - without
 * them a review cannot be driven, and a frame that has quietly lost its tail is
 * a frame where the person is looking at a form with no way to fill it in. The
 * rule that degrades the footer, `footerLines.length = 0` followed by a push of
 * the essential band, is the one place that could take them: it empties the
 * array before rebuilding it, so a mistake in what it reads back would leave a
 * band of blanks rather than the controls. It reads a separate `essentialFooter`
 * const, built before the clear, and these cases hold that line.
 *
 * The note editor is a different view and is deliberately not on this list: it
 * is a modal field with its own line ("Enter to submit"), and asserting the
 * review's controls on it is asserting the wrong thing.
 */
describe("every review view keeps the panel's footer tail", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const RULE = /^[─━═_-]{10,}$/;
  const HINTS = /↑↓ move/;
  const AUTO = /auto-resolve/;
  const DENSITY = /density: (comfortable|compact)/;

  const build = (options, multiSelect) => normalizeReview({
    reviewId: "tail", images: "on",
    stages: [
      {
        id: "one", header: "One", prompt: "Which treatment ships first?", multiSelect,
        options: Array.from({ length: options }, (_, index) => ({
          id: `a${index}`, label: `Option ${index + 1}`,
          description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
        })),
      },
      {
        id: "two", header: "Two", prompt: "And the second?", multiSelect: false,
        options: [
          { id: "b0", label: "Second A", description: "one reason line" },
          { id: "b1", label: "Second B", description: "one reason line" },
        ],
      },
    ],
  });

  const assertTail = (component, width, tag) => {
    const lines = component.render(width).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
    const frame = lines.join("\n");
    assert.ok(HINTS.test(frame), `${tag}: the key hints are on screen`);
    assert.ok(AUTO.test(frame), `${tag}: the auto-resolve line is on screen`);
    assert.ok(DENSITY.test(frame), `${tag}: the density line is on screen`);
    assert.ok(lines.some((line) => RULE.test(line.trim())), `${tag}: the closing rule is on screen`);
    // The tail is a block, not four lines scattered across the frame: the hints
    // sit directly above the auto-resolve and density lines, and the rule is the
    // last thing on screen. A tail whose parts survive but fall apart is a tail
    // that has come unstuck.
    const hintAt = lines.findIndex((line) => HINTS.test(line));
    const autoAt = lines.findIndex((line) => AUTO.test(line));
    const densityAt = lines.findIndex((line) => DENSITY.test(line));
    // The frame is ruled at the top as well as the bottom, so the closing rule
    // is the *last* one on screen.
    const ruleAt = lines.findLastIndex((line) => RULE.test(line.trim()));
    assert.ok(
      hintAt >= 0 && autoAt === hintAt + 1 && densityAt === autoAt + 1 && ruleAt > densityAt,
      `${tag}: the tail is one block - hints ${hintAt}, auto ${autoAt}, density ${densityAt}, rule ${ruleAt}`,
    );
  };

  // 59 and 61 straddle the `safeWidth >= 60` gate that builds the footer band,
  // so the essential-band fallback is exercised on both sides of it.
  for (const columns of [59, 60, 61, 80]) {
    for (const rows of [44, 30]) {
      it(`keeps the tail on the stage, after a note, and on the review tab at ${columns}x${rows}`, async () => {
        for (const options of [3, 14]) {
          for (const multiSelect of [false, true]) {
            const component = new VisualReviewWizard(
              { requestRender: () => {}, terminal: { rows, columns } },
              plainTheme, build(options, multiSelect), process.cwd(), () => {},
            );
            const tag = `${options} options, multiSelect=${multiSelect}, ${columns}x${rows}`;

            assertTail(component, 100, `${tag}, first frame`);

            // A note adds rows to the tail, which is the row the squeeze has to
            // give up first.
            component.handleInput("\t");
            component.handleInput("n");
            component.handleInput("a short note");
            component.handleInput("\r");
            component.handleInput("\u001b");
            assertTail(component, 100, `${tag}, with a note`);

            // Answer the first stage, then the second, which lands on the review
            // tab - the one view with no stage of its own.
            component.handleInput("\u001b[B");
            component.handleInput("\r");
            assertTail(component, 100, `${tag}, stage answered`);
            if (multiSelect) {
              component.handleInput(" ");
              component.handleInput("\u001b[B");
              component.handleInput("\u001b[B");
              component.handleInput("\u001b[B");
            }
            component.handleInput("\r");
            assertTail(component, 100, `${tag}, review tab`);
            component.dispose();
          }
        }
      }, { timeout: 30000 });
    }
  }
});

/**
 * The essential-band fallback keeps the tail, and actually runs.
 *
 * The cases above never reach the one line that can take the footer apart: when
 * the panel cannot give the picture its floor, the full footer band is thrown
 * away and rebuilt from the essential one - the question and the choices with no
 * reason under each. It fires in 450 of the image-layout configurations tried
 * (a stage whose options carry a picture, four or more of them, comfortable),
 * and it is the only place that empties an array and pushes into it again, so it
 * is the only place a footer can silently become a band of blanks.
 *
 * The rule is *no change to the controls*: the tail is the review's interface,
 * and degrading the band above it must never cost a line from it.
 *
 * Pinned by mutation, not just by intent. Aliasing the array into a local
 * before emptying it - the shape that makes the rebuild push what is now an
 * empty array - leaves the tail perfectly intact and fails only the
 * fixed-height case: the band comes out empty, the slack that was padding the
 * picture is given to nothing, and the frame grows from the panel's 32 rows to
 * all 44. That is the whole argument for asserting the height and not only the
 * controls, so it is asserted on every case here.
 */
describe("the essential-band fallback leaves the tail alone", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const RULE = /^[─━═_-]{10,}$/;
  const HINTS = /↑↓ move/;
  const AUTO = /auto-resolve/;
  const DENSITY = /density: (comfortable|compact)/;
  const image = new URL("../.pi/benchmark/images/visual-001-option-1.png", import.meta.url).pathname;

  for (const columns of [60, 80]) {
    for (const rows of [44, 30]) {
      it(`keeps the tail when the fallback drops the reasons at ${columns}x${rows}`, async () => {
        const { setCapabilities } = await import("@earendil-works/pi-tui");
        const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
        try {
          let exercised = 0;
          for (const options of [4, 8, 14, 20]) {
            for (const multiSelect of [false, true]) {
              const review = normalizeReview({
                reviewId: "fallback", images: "on",
                stages: [{
                  id: "one", header: "Treatment", prompt: "Which treatment ships first?", multiSelect,
                  options: Array.from({ length: options }, (_, index) => ({
                    id: `o${index}`, label: `Option ${index + 1}`, image: { path: image, alt: "Fixture" },
                    description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
                  })),
                }],
              });
              const component = new VisualReviewWizard(
                { requestRender: () => {}, terminal: { rows, columns } },
                plainTheme, review, process.cwd(), () => {},
              );
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 25));
              // `reasonsDropped` is decided during the render, so the frame has
              // to be built before it can be read back.
              const lines = component.render(100).map((line) => line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, ""));
              if (component.reasonsDropped) exercised += 1;
              const frame = lines.join("\n");
              const tag = `${options} options, multiSelect=${multiSelect}, ${columns}x${rows}, reasonsDropped=${component.reasonsDropped}`;
              assert.ok(HINTS.test(frame), `${tag}: the key hints survived`);
              assert.ok(AUTO.test(frame), `${tag}: the auto-resolve line survived`);
              assert.ok(DENSITY.test(frame), `${tag}: the density line survived`);
              assert.ok(lines.some((line) => RULE.test(line.trim())), `${tag}: the closing rule survived`);
              // And the band above is not a row of blanks: the question is still
              // there, and the choices with it.
              assert.ok(/Which treatment ships first\?/.test(frame), `${tag}: the question is still on screen`);
              // The panel is a fixed block and not the terminal. This is the
              // assertion that catches the fallback rebuilding the band from
              // the array it had just emptied: the band comes out empty, the
              // slack that was padding the picture is handed to nothing, and the
              // frame quietly grows until it fills every row - the panel stops
              // being a panel. At twenty options or fewer it is 32-33 rows on a
              // 44-row terminal; 44 is the bug.
              assert.ok(
                lines.length <= 36,
                `${tag}: the panel keeps its fixed height - the frame is ${lines.length} of ${rows} rows`,
              );
              assert.ok(
                new RegExp(`(?:> )?(?:\\d+\\. |\\[[ x]\\] )Option 1\\b`).test(frame),
                `${tag}: the first choice is still on screen`,
              );
              component.dispose();
            }
          }
          assert.ok(exercised > 0, "the fallback actually ran in this configuration, so the case is not vacuous");
        } finally {
          if (previous) setCapabilities(previous);
        }
      }, { timeout: 30000 });
    }
  }
});
