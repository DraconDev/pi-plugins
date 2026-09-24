#!/usr/bin/env node
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { VisualReviewWizard } from "../src/tui.ts";
import { normalizeReview } from "../src/schema.ts";

export const EVIDENCE_WIDTH = 100;

/** Remove terminal styling while preserving the exact component layout. */
export function stripTerminalMarkup(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r/g, "");
}

/** Build the stable review used by the checked-in visual evidence artifact. */
export function createEvidenceReview(root) {
  return normalizeReview({
    reviewId: "tui-evidence",
    title: "TUI evidence",
    stages: [{
      id: "layout",
      header: "Layout",
      prompt: "Choose a layout",
      options: [
        { id: "grid", label: "Grid", image: { path: relative(root, resolve(root, "tests/fixtures/tiny.png")), alt: "Tiny checked-in fixture" } },
        { id: "stack", label: "Stack", description: "A vertical alternative" },
      ],
    }],
  });
}

/** Render the actual component, not a hand-written mockup, to plain text. */
export function renderEvidenceText(root) {
  const review = createEvidenceReview(root);
  const component = new VisualReviewWizard(
    { requestRender: () => {} },
    { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text },
    review,
    root,
    () => {},
  );
  try {
    const rendered = component.render(EVIDENCE_WIDTH).map(stripTerminalMarkup).join("\n");
    const rootUrl = pathToFileURL(root).href;
    return `${rendered.split(rootUrl).join("file://<repo>").split(root).join("<repo>")}\n`;
  } finally {
    component.dispose();
  }
}
