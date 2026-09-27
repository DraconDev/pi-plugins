import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Key, matchesKey } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../src/tui.ts";
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

  it("keeps one line per row beside an image, and spells the option out with its preview", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const { fileURLToPath } = await import("node:url");
    const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    try {
      const fixture = fileURLToPath(new URL("./fixtures/tiny.png", import.meta.url));
      const review = normalizeReview({
        reviewId: "side-by-side",
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
      while (Date.now() < deadline && component.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 50));
      assert.ok(component.loadedImages.size > 0, "the fixture image must load or this proves nothing about the side-by-side layout");
      const frame = component.render(110);
      // Side by side, every terminal line carries the left column and the
      // preview, so the column is read as the leading slice of each line.
      const leftColumn = frame.map((line) => line.slice(0, 45));
      const rightColumn = frame.map((line) => line.slice(45));
      assert.equal(leftColumn.filter((line) => line.includes("1. Transit airy")).length, 1, "an option is one row, not a label plus three wrapped lines");
      assert.ok(!leftColumn.some((line) => line.includes("Favors quick orientation")), "the description must not wrap into the narrow column");
      assert.ok(rightColumn.some((line) => line.includes("Favors quick orientation")), "the description is spelled out with the preview");
      // The image really is inline.
      assert.ok(frame.some((line) => line.includes("\u001b_G")), "the preview carries the graphics escape");
      component.dispose();
    } finally {
      if (previous) setCapabilities(previous);
    }
  });

  it("says why there is no picture instead of printing a bare file path", async () => {
    const { setCapabilities } = await import("@earendil-works/pi-tui");
    const previous = setCapabilities({ images: null, trueColor: true, hyperlinks: false });
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
      assert.match(text, /cannot draw inline images/, "a host that cannot render images must say so");
      assert.match(text, /PI_IMAGE_PROTOCOL=kitty/, "and must name the switch that turns it on");
      component.dispose();
    } finally {
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
