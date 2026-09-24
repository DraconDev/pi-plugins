#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { setCapabilityOverrides, resetCapabilitiesCache } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { Key, matchesKey } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/keys.js";
import { VisualReviewWizard } from "../src/tui.ts";
import { normalizeReview } from "../src/schema.ts";

setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false, sixel: false, kitty: false });
try {
  const review = normalizeReview({
    reviewId: "tui-smoke",
    title: "TUI smoke",
    stages: [
      { id: "single", header: "Single", prompt: "Choose one", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
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

  const abortReview = normalizeReview({ reviewId: "abort-smoke", stages: [{ id: "required", header: "Required", prompt: "Required", options: [{ label: "A" }, { label: "B" }] }] });
  const controller = new AbortController();
  let abortResult;
  const abortWizard = new VisualReviewWizard(tui, theme, abortReview, process.cwd(), (value) => { abortResult = value; }, [], controller.signal);
  controller.abort();
  assert.equal(abortResult?.status, "cancelled");
  assert.equal(abortResult?.cancelled, true);
  abortWizard.dispose();

  const fixture = new URL("../tests/fixtures/tiny.png", import.meta.url);
  const fixtureBytes = await readFile(fixture);
  assert.equal(fixtureBytes.length > 0, true);
  console.log(JSON.stringify({ renders, resultStatus: result?.status, abortStatus: abortResult?.status, fixtureBytes: fixtureBytes.length }, null, 2));
} finally {
  resetCapabilitiesCache();
}
