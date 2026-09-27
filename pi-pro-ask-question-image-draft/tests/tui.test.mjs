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
      // Nothing is cut off: the frame is exactly the terminal, with no scroll hints.
      assert.equal(frame.length, 40, "the frame fills the terminal exactly");
      assert.doesNotMatch(rows.join("\n"), /content (above|below)/, "and no row is clipped");
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
      const review = normalizeReview({
        reviewId: "no-images",
        stages: [{ id: "one", header: "One", prompt: "Pick", options: [
          { id: "a", label: "A", image: { path: "/nowhere/missing.png" } },
          { id: "b", label: "B", image: { path: "/nowhere/also-missing.png" } },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      await new Promise((r) => setTimeout(r, 200));
      const text = component.render(110).join("\n");
      assert.match(text, /Inline images are off here/, "a host that cannot render images must say so");
      assert.match(text, /detected none/, "and name what it actually detected, not a guess");
      assert.match(text, /PI_IMAGE_PROTOCOL=kitty/, "and name the switch that turns it on");
      component.dispose();
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      if (previous) setCapabilities(previous);
    }
  });
});

/**
 * tmux passthrough for inline graphics.
 *
 * Measured on tmux 3.6a: a frame carrying a 527,315-byte PNG reached the
 * attached terminal with *zero* payload bytes, because tmux does not forward
 * an escape it does not parse. Wrapping in the passthrough envelope - with the
 * chunked escape collapsed first, because the envelope ends at the first ST
 * inside it - delivered the whole image. These pin that transformation, and
 * pin that it stays inert everywhere else.
 */
describe("tmux passthrough: the image escape has to survive the multiplexer", () => {
  const chunked = [
    "\u001b_Ga=T,f=100,c=30,r=20,i=7,m=1;AAAA",
    "\u001b_Gm=1;BBBB",
    "\u001b_Gm=0;CCCC",
  ].join("\u001b\\") + "\u001b\\";

  it("collapses a chunked kitty escape into one, keeping every byte of the payload", async () => {
    const { collapseGraphicsChunks } = await import("../src/tui.ts");
    const collapsed = collapseGraphicsChunks(chunked);
    assert.ok(collapsed.includes("AAAA"), "the first chunk survives");
    assert.ok(collapsed.includes("CCCC"), "the last chunk survives");
    assert.equal((collapsed.match(/\u001b_G/g) ?? []).length, 1, "one escape, not four");
    assert.equal((collapsed.match(/\u001b\\/g) ?? []).length, 1, "one terminator, so the passthrough envelope is not cut short");
    assert.equal(/[;,]m=\d/.test(collapsed), false, "the continuation flags are gone with the chunks");
    assert.equal(collapseGraphicsChunks("  1. Transit airy"), "  1. Transit airy", "text is never touched");
  });

  it("wraps graphics in the tmux envelope inside tmux, and nowhere else", async () => {
    const { collapseGraphicsChunks, passthroughGraphicsForHost } = await import("../src/tui.ts");
    const wrapped = passthroughGraphicsForHost(chunked, { tmux: true });
    const open = "\u001bPtmux;";
    assert.ok(wrapped.startsWith(open), "the envelope tmux forwards is present");
    assert.ok(wrapped.endsWith("\u001b\\"), "and it is closed");
    // The envelope ends at the first ST, so the payload it carries must contain
    // exactly one - the terminator of the single collapsed escape.
    const inner = wrapped.slice(open.length, -"\u001b\\".length);
    assert.equal(inner, collapseGraphicsChunks(chunked), "the envelope carries the collapsed escape and nothing else");
    assert.equal((inner.match(/\u001b\\/g) ?? []).length, 1, "one terminator inside the envelope");
    assert.equal((wrapped.match(/\u001bPtmux;/g) ?? []).length, 1, "one envelope per image, not one per chunk");
    assert.equal(passthroughGraphicsForHost(chunked, { tmux: false }), chunked, "outside tmux the escape is untouched");
    assert.equal(passthroughGraphicsForHost("Preview: Transit airy", { tmux: true }), "Preview: Transit airy", "a text line is untouched");
    // The display command pi-tui sends after the payload is an image line too,
    // and it has to travel inside the envelope as well.
    const display = "\u001b_Ga=d,d=I,i=7,q=2\u001b\\";
    assert.equal(passthroughGraphicsForHost(display, { tmux: true }), `${open}${display}\u001b\\`);
  });
});

/**
 * The dialog people actually see: a review whose prompt is a paragraph and
 * whose options carry no image. Before this, the prompt filled a third of the
 * frame, the selected option's description was printed twice, and a preview
 * block announced that there was nothing to preview.
 */
describe("chrome: a text-only review stays a questionnaire", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const longPrompt = Array.from({ length: 8 }, (_, index) => `line ${index + 1} of a model-written paragraph about the decision at hand`).join(" ");
  const build = () => {
    const review = normalizeReview({
      reviewId: "text-only",
      title: "Audit pass",
      stages: [{
        id: "one", header: "Watch card identity", prompt: longPrompt,
        options: [
          { id: "pin", label: "Pin against release.json", description: "Keeps a deliberate human-reviewed pin." },
          { id: "defer", label: "Defer", description: "Leave the current behaviour and note it for later." },
        ],
      }],
    });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
    return { component, get result() { return result; } };
  };

  it("clamps a paragraph prompt and says how to read the rest", () => {
    const { component } = build();
    const text = component.render(110).join("\n");
    assert.ok(text.includes("line 1 of a model-written paragraph"), "the prompt starts at its first line");
    assert.ok(text.includes("more lines — press ctrl+r"), "and says the rest is one keypress away");
    assert.equal(text.includes("line 8 of a model-written paragraph"), false, "the tail is not dumped by default");
    // The same prompt, expanded, shows everything - and only once.
    component.handleInput("\u0012");
    const expanded = component.render(110).join("\n");
    assert.ok(expanded.includes("line 8 of a model-written paragraph"), "ctrl+r reads the whole prompt");
    assert.equal((expanded.match(/line 1 of a model-written paragraph/g) ?? []).length, 1, "and the prompt is not printed twice");
    component.dispose();
  });

  it("does not repeat the selected option's description or announce an empty preview", () => {
    const { component } = build();
    const text = component.render(110).join("\n");
    assert.equal(
      (text.match(/Keeps a deliberate human-reviewed pin\./g) ?? []).length,
      1,
      "the description is shown once, under its row",
    );
    assert.equal(text.includes("No inline preview supplied."), false, "a text option does not get a dead preview block");
    assert.ok(text.includes("1. Pin against release.json"), "options are numbered");
    assert.ok(text.includes("Type something."), "the action rows sit behind a rule, unnumbered");
    assert.ok(text.includes("Add note"), "and a note is a row, not a key nobody can see");
    component.dispose();
  });
});

/**
 * The dashboard as asked for: a full-screen panel you can get out of the way
 * of, with notes and checkboxes in the list, and an auto-resolve switch that is
 * off unless the user turns it on.
 */
describe("dashboard: hideable, checkboxes, notes, and an off-by-default auto-resolve", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const dashboardReview = (extra = {}) => normalizeReview({
    reviewId: "dashboard",
    title: "Onboarding",
    stages: [
      { id: "channels", header: "Channels", prompt: "Which channels ship?", multiSelect: true, options: [
        { id: "inapp", label: "In-app banner", description: "Reaches a signed-out user." },
        { id: "email", label: "Email digest", description: "Daily rollup." },
      ] },
      { id: "copy", header: "Copy", prompt: "Which headline?", options: [
        { id: "short", label: "Short headline", description: "Three words.", recommended: true },
        { id: "long", label: "Full sentence", description: "More scrolling." },
      ] },
    ],
    ...extra,
  });
  const build = (extra = {}) => {
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, plainTheme, dashboardReview(extra), process.cwd(), (value) => { result = value; });
    return { component, get result() { return result; } };
  };

  it("renders checkboxes for a multi-select stage and a row for the note", () => {
    const { component } = build();
    const text = component.render(110).join("\n");
    assert.match(text, /\[ \]\s*In-app banner/, "an unchecked option is a checkbox");
    component.handleInput(" ");
    const checked = component.render(110).join("\n");
    assert.match(checked, /\[x\]\s*In-app banner/, "a checked option says so");
    assert.ok(text.includes("Add note"), "a note is a row, not a hidden key");
    component.dispose();
  });

  it("hides the whole panel to one line and brings it back with the answers kept", () => {
    const { component } = build();
    component.handleInput(" ");
    moveTo(component, "Done selecting");
    enter(component);
    component.handleInput("\u001d");
    const hidden = component.render(110).join("\n");
    assert.equal(hidden.split("\n").filter((line) => line.trim()).length, 1, "hidden is one line, so the transcript is readable");
    assert.match(hidden, /Review hidden/, "and it says what happened");
    assert.match(hidden, /1 answered/, "the hidden line says how much is already done");
    assert.match(hidden, /answers kept/, "and that nothing was lost");
    component.handleInput("\u001d");
    const back = component.render(110).join("\n");
    assert.match(back, /✓ Channels/, "the answered stage is still ticked, so the answer survived the round trip");
    component.dispose();
  });

  it("auto-resolve is off by default, and on it lands on the recommended row without answering", () => {
    const off = build();
    const offText = off.component.render(110).join("\n");
    assert.match(offText, /auto-resolve: off/, "an off switch nobody can see is a switch nobody trusts");
    // Off, the recommendation does not pull the cursor: the user moves to the
    // row they want and it stays theirs.
    off.component.handleInput("\t");
    off.component.handleInput("\x1b[B");
    assert.equal(activeRow(off.component, 110), "Full sentence", "the user moved, and nothing moved it back");
    off.component.dispose();

    const on = build();
    on.component.handleInput("\t");
    on.component.handleInput("\u0001");
    const onText = on.component.render(110).join("\n");
    assert.match(onText, /auto-resolve: on/, "the mode is stated");
    assert.equal(activeRow(on.component, 110), "Short headline", "the cursor is on the recommended option");
    assert.match(onText, /\(recommended\)/, "and the row says why it is there");
    assert.equal(on.result, undefined, "nothing is answered until the user presses Enter");
    enter(on.component);
    // The stage is answered, so its tab is ticked; the review itself stays open
    // because the multi-select stage is still unanswered.
    assert.match(on.component.render(110).join("\n"), /✓ Copy/, "Enter took the recommendation");
    assert.equal(on.result, undefined, "and the review is not finished by one Enter");
    moveTo(on.component, "Done selecting");
    on.component.handleInput(" ");
    enter(on.component);
    // The multi-select stage is still open, which is the point: one Enter took
    // the recommendation and stopped there.
    moveTo(on.component, "Done selecting");
    assert.ok(activeRow(on.component, 110), "the review is still waiting for the other stage");
    on.component.dispose();
  });

  it("a review can ask for auto-resolve up front, and the switch still turns it off", () => {
    const asked = build({ autoResolve: true });
    asked.component.handleInput("\t");
    assert.equal(activeRow(asked.component, 110), "Short headline", "the review asked for it, so the cursor is already there");
    asked.component.handleInput("\u0001");
    assert.match(asked.component.render(110).join("\n"), /auto-resolve: off/, "and the user can always turn it off");
    asked.component.dispose();
  });

  it("a stage with no marked option falls back to the first, and never fights navigation", () => {
    const plain = normalizeReview({
      reviewId: "plain", autoResolve: true,
      stages: [{ id: "one", header: "One", prompt: "Pick", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
    });
    let result;
    const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 40 } }, plainTheme, plain, process.cwd(), (value) => { result = value; });
    assert.equal(activeRow(component, 110), "A", "no recommendation means the first option");
    component.handleInput("\x1b[B");
    assert.equal(activeRow(component, 110), "B", "and the user's own navigation is not undone");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    assert.equal(activeRow(component, 110), "Request revision", "the list reaches its last row");
    component.handleInput("\x1b[B");
    assert.equal(activeRow(component, 110), "A", "and wraps, the way a list should");
    component.dispose();
  });
});

/**
 * The image bytes, verified as bytes.
 *
 * "Is the image feature working?" splits into three questions, and only the
 * last needs a human eye: do the bytes reach the terminal (a PTY answers that),
 * are they the right bytes in a sequence a conforming terminal accepts (this
 * answers that), and does your terminal draw them (a person answers that).
 *
 * The iTerm2 case is why this exists. pi-tui's iTerm2 encoder declared
 * `size=527315` and wrote **62 bytes** of PNG with no terminator, so an
 * iTerm2-style terminal never got a picture at all - and nothing in the suite
 * noticed, because the smoke only ever counted bytes written.
 */
describe("images: the emitted sequence carries the whole image", () => {
  const plainTheme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
  const fixtureBytes = readFileSync(fixture);

  async function frameWith(protocol) {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
    try {
      const review = normalizeReview({
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

  it("tmux: the same bytes, one escape, inside a passthrough envelope", async () => {
    const { parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    const previous = process.env.TMUX;
    process.env.TMUX = "on";
    let frame;
    try {
      frame = await frameWith("kitty");
    } finally {
      if (previous === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous;
    }
    const { images } = parseKitty(frame);
    assert.equal(images.length, 1, "one escape, not one per chunk");
    assert.equal(images[0].wrapped, true, "inside a passthrough envelope");
    assert.deepEqual(Buffer.from(images[0].payload, "base64"), fixtureBytes, "the payload survives the wrapper");
  });

  it("a multi-chunk image reassembles - the case a small fixture cannot cover", async () => {
    const { parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    // tests/fixtures/tiny.png is 68 bytes: 92 base64 characters, a single chunk.
    // Anything over ~3 KB is transmitted as several escapes, and a parser that
    // starts a new image on the final chunk would report one 71 KB picture as
    // 69,206 + 2,068 bytes. This is the test that would have caught it.
    const big = fileURLToPath(new URL("./fixtures/tui-smoke.png", import.meta.url));
    const bytes = readFileSync(big);
    assert.ok(bytes.length > 3_072, "this fixture must be big enough to be chunked");
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    // Inside tmux the package collapses the chunks into one passthrough escape,
    // so this test clears the variable to exercise the raw chunked path - which
    // is what a terminal outside tmux receives.
    const previousTmux = process.env.TMUX;
    delete process.env.TMUX;
    try {
      const review = normalizeReview({
        reviewId: "image-chunks",
        stages: [{ id: "one", header: "One", prompt: "Pick", options: [
          { id: "a", label: "A", image: { path: big } },
          { id: "b", label: "B" },
        ] }],
      });
      let result;
      const component = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 46 } }, plainTheme, review, process.cwd(), (value) => { result = value; });
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 40));
      assert.ok(component.loadedImages.size > 0, "the image must load");
      const { images } = parseKitty(component.render(100).join("\r\n"));
      component.dispose();
      assert.equal(images.length, 1, "one image, not one per chunk");
      assert.ok(images[0].chunks > 1, `the transmission must actually be chunked (${images[0].chunks} chunks)`);
      assert.equal(images[0].more, false, "and it must end on a non-continuation chunk");
      assert.deepEqual(Buffer.from(images[0].payload, "base64"), bytes, "every chunk, reassembled, is the file");
    } finally {
      if (previous) setCapabilities(previous);
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
    }
  });

  it("a control command is not a broken image", async () => {
    const { parseKitty } = await import("../scripts/benchmark/image-protocol.mjs");
    // pi-tui sends `a=d,d=I,i=<id>` after the payload: same escape family, no
    // data. Reporting it as a two-byte image is how a working package looks broken.
    const { images, commands } = parseKitty("\u001b_Ga=T,f=100,c=2,r=2,m=0;AAAA\u001b\\\u001b_Ga=d,d=I,i=7,q=2\u001b\\");
    assert.equal(images.length, 1, "one data transmission");
    assert.equal(commands.length, 1, "and one display command, kept apart");
    assert.equal(commands[0].keys.a, "d");
  });

  it("a terminal that cannot draw images says so, and names the switch", () => {
    // Covered in the chrome block above; asserted here too so the image contract
    // and the host contract are read together.
    assert.equal(typeof terminateITerm2Images, "function");
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

      // The highlighted option's sentence is on screen, the other two are not.
      const described = indexOf("Scans fastest");
      assert.ok(described >= 0, "the highlighted option's sentence is shown");
      assert.equal(plain().some((line) => line.includes("Cause beside remedy")), false, "and only that one");
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
