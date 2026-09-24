#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { setCapabilityOverrides, resetCapabilitiesCache } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { Key, matchesKey } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/keys.js";
import { buildResponse } from "../src/envelope.ts";
import { VisualReviewWizard } from "../src/tui.ts";
import { normalizeReview } from "../src/schema.ts";

setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false, sixel: false, kitty: false });
try {
  const fixtureUrl = new URL("../tests/fixtures/tiny.png", import.meta.url);
  const fixturePath = fileURLToPath(fixtureUrl);
  const fixtureBytes = await readFile(fixtureUrl);
  assert.equal(fixtureBytes.length > 0, true);

  const review = normalizeReview({
    reviewId: "tui-smoke",
    title: "TUI smoke",
    stages: [
      { id: "single", header: "Single", prompt: "Choose one", options: [{ id: "a", label: "A", image: { path: fixturePath, alt: "Tiny fixture" } }, { id: "b", label: "B" }] },
      { id: "multi", header: "Multi", prompt: "Choose many", multiSelect: true, options: [{ id: "c", label: "C" }, { id: "d", label: "D" }] },
      { id: "optional", header: "Optional", prompt: "Optional", required: false, options: [{ id: "e", label: "E" }, { id: "f", label: "F" }] },
    ],
  });
  let renders = 0;
  const tui = { requestRender: () => { renders += 1; } };
  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
  };
  let result;
  const wizard = new VisualReviewWizard(tui, theme, review, process.cwd(), (value) => { result = value; });
  assert.match(wizard.render(100).join("\n"), /TUI smoke/);
  wizard.handleInput("\r");
  assert.equal(wizard.render(100).join("\n").includes("Choose many"), true);
  wizard.handleInput(" ");
  wizard.handleInput("\x1b[B");
  wizard.handleInput(" ");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.equal(wizard.render(100).join("\n").includes("Optional"), true);
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  assert.equal(result?.status, "completed");
  assert.deepEqual(result?.answers.map((answer) => answer.stageId), ["single", "multi"]);
  assert.deepEqual(result?.skippedStageIds, ["optional"]);
  wizard.dispose();
  assert.equal(renders > 0, true);

  assert.equal(matchesKey("\r", Key.enter), true);
  assert.equal(matchesKey("\n", Key.enter), true);
  assert.equal(matchesKey("\r", Key.space), false);
  assert.equal(matchesKey("\x1b", Key.escape), true);

  function makeWizard(smokeReview) {
    let result;
    const component = new VisualReviewWizard(tui, theme, smokeReview, process.cwd(), (value) => { result = value; });
    return { component, get result() { return result; } };
  }

  function down(component, count = 1) {
    for (let index = 0; index < count; index += 1) component.handleInput("\x1b[B");
  }

  function enter(component) {
    component.handleInput("\r");
  }

  // Drive the custom-answer path in the scripted component smoke, not only in
  // the unit suite. The selected stage is deliberately answered through the
  // editor row so the result carries the public custom-answer envelope.
  const customReview = normalizeReview({
    reviewId: "custom-smoke",
    stages: [{ id: "custom", header: "Custom", prompt: "Add context", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  });
  const customState = makeWizard(customReview);
  down(customState.component, 2);
  enter(customState.component);
  customState.component.handleInput("custom context");
  enter(customState.component);
  enter(customState.component);
  assert.equal(customState.result?.status, "completed");
  assert.equal(customState.result?.answers[0]?.kind, "custom");
  assert.equal(customState.result?.answers[0]?.customText, "custom context");
  assert.match(buildResponse(customState.result, customReview).content[0].text, /custom context/);
  customState.component.dispose();

  // Revision is an early terminal outcome: selecting Request revision opens
  // the editor and the submitted feedback becomes the next-round envelope.
  const revisionReview = normalizeReview({
    reviewId: "revision-smoke",
    round: 3,
    stages: [{ id: "revision", header: "Revision", prompt: "Review the draft", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  });
  const revisionState = makeWizard(revisionReview);
  down(revisionState.component, 3);
  enter(revisionState.component);
  revisionState.component.handleInput("make it bolder");
  enter(revisionState.component);
  assert.equal(revisionState.result?.status, "revision");
  assert.equal(revisionState.result?.decision, "revision");
  assert.equal(revisionState.result?.revision?.feedback, "make it bolder");
  assert.equal(revisionState.result?.revision?.requestedRound, 4);
  assert.match(buildResponse(revisionState.result, revisionReview).content[0].text, /make it bolder/);
  revisionState.component.dispose();

  // Reject is a distinct terminal outcome and must not be represented as a
  // cancellation or an approval envelope.
  const rejectReview = normalizeReview({
    reviewId: "reject-smoke",
    stages: [{ id: "reject", header: "Reject", prompt: "Review the draft", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }],
  });
  const rejectState = makeWizard(rejectReview);
  down(rejectState.component, 5);
  enter(rejectState.component);
  assert.equal(rejectState.result?.status, "rejected");
  assert.equal(rejectState.result?.decision, "reject");
  assert.equal(rejectState.result?.cancelled, false);
  assert.match(buildResponse(rejectState.result, rejectReview).content[0].text, /rejected/);
  rejectState.component.dispose();

  const abortReview = normalizeReview({ reviewId: "abort-smoke", stages: [{ id: "required", header: "Required", prompt: "Required", options: [{ label: "A" }, { label: "B" }] }] });
  const controller = new AbortController();
  let abortResult;
  const abortWizard = new VisualReviewWizard(tui, theme, abortReview, process.cwd(), (value) => { abortResult = value; }, [], controller.signal);
  controller.abort();
  assert.equal(abortResult?.status, "cancelled");
  assert.equal(abortResult?.cancelled, true);
  abortWizard.dispose();

  console.log(JSON.stringify({
    renders,
    resultStatus: result?.status,
    customStatus: customState.result?.status,
    revisionStatus: revisionState.result?.status,
    rejectStatus: rejectState.result?.status,
    abortStatus: abortResult?.status,
    fixtureBytes: fixtureBytes.length,
  }, null, 2));
} finally {
  resetCapabilitiesCache();
}
