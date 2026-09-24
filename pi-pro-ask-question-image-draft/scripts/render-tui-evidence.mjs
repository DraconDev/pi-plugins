#!/usr/bin/env node
/**
 * Capture a deterministic text snapshot of the real VisualReviewWizard render.
 *
 * The companion render-tui-evidence.py turns this snapshot into a PNG for
 * visual review. Keeping the text intermediate checked in makes it possible to
 * prove that the image evidence came from the component rather than a mockup.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resetCapabilitiesCache, setCapabilityOverrides } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { VisualReviewWizard } from "../src/tui.ts";
import { normalizeReview } from "../src/schema.ts";

const root = resolve(new URL("..", import.meta.url).pathname);
const outputPath = resolve(process.argv[2] ?? resolve(root, "tests/fixtures/tui-smoke.txt"));
const fixturePath = relative(root, resolve(root, "tests/fixtures/tiny.png"));

function stripAnsi(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "");
}

setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false, sixel: false, kitty: false });
try {
  const review = normalizeReview({
    reviewId: "tui-evidence",
    title: "TUI evidence",
    stages: [{
      id: "layout",
      header: "Layout",
      prompt: "Choose a layout",
      options: [
        { id: "grid", label: "Grid", image: { path: fixturePath, alt: "Tiny checked-in fixture" } },
        { id: "stack", label: "Stack", description: "A vertical alternative" },
      ],
    }],
  });
  const component = new VisualReviewWizard(
    { requestRender: () => {} },
    { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    review,
    root,
    () => {},
  );
  const snapshot = `${component.render(100).map(stripAnsi).join("\n")}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, snapshot, "utf8");
  console.log(JSON.stringify({ outputPath: relative(root, outputPath), bytes: Buffer.byteLength(snapshot), width: 100 }, null, 2));
  component.dispose();
} finally {
  resetCapabilitiesCache();
}
