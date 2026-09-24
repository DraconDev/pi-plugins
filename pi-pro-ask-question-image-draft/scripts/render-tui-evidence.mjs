#!/usr/bin/env node
/** Capture the plain-text intermediate for the checked-in TUI PNG evidence. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { resetCapabilitiesCache, setCapabilityOverrides } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { renderEvidenceText } from "./tui-evidence.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const outputPath = resolve(process.argv[2] ?? resolve(root, "tests/fixtures/tui-smoke.txt"));

setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false, sixel: false, kitty: false });
try {
  const snapshot = renderEvidenceText(root);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, snapshot, "utf8");
  console.log(JSON.stringify({ outputPath: relative(root, outputPath), bytes: Buffer.byteLength(snapshot), width: 100 }, null, 2));
} finally {
  resetCapabilitiesCache();
}
