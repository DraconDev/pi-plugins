#!/usr/bin/env node
/**
 * Render the real review dialog to a PNG screenshot.
 *
 * Why this exists
 * ---------------
 * The live smoke proves the dialog *works* on a real terminal, and every
 * artifact it leaves behind is escape codes and JSON - neither of which shows a
 * human what the review actually looks like. "It is broken compared to the
 * reference" is not an answerable complaint when nobody can see the thing, so
 * this renders the *real* `VisualReviewWizard` frame - same component, same
 * renderer, same inline-image protocol the terminal receives - and rasterises
 * it with a real monospace font and the real image bytes.
 *
 * The frame is not simulated: `wizard.render(columns)` returns the exact lines
 * pi-tui paints, the Kitty escape is decoded to the PNG the terminal draws, and
 * the cell box comes from the same control data. A screenshot can therefore be
 * wrong only if the dialog is wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setCapabilityOverrides, resetCapabilitiesCache } from "/home/dracon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/terminal-image.js";
import { setCapabilities as setTopLevelCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [key, ...rest] = token.slice(2).split("=");
    if (rest.length) { args[key] = rest.join("="); continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { args[key] = next; index += 1; continue; }
    args[key] = "true";
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const imagePath = resolve(args.image ?? ".pi/benchmark/images/visual-001-option-1.png");
/** One image per treatment, so a screenshot can show the actual comparison. */
const treatmentImages = (typeof args.images === "string" && args.images.trim()
  ? args.images.split(",").map((value) => resolve(value.trim()))
  : [imagePath]);
const outPath = resolve(args.out ?? ".pi/benchmark/shots/review.png");
const columns = Number(args.columns ?? 110);
const rows = Number(args.rows ?? 40);
const optionIndex = Number(args.option ?? 0);

/** Strip SGR, cursor movement and the graphics protocol, keeping the printable columns. */
const plain = (line) => line
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b_G[^\x1b]*(?:\x1b\\|\x07)/g, "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
  .replace(/\x1b[@-Z\\-_]/g, "");

/** Display width of a plain line: the wizard is monospace, so length is width. */
const width = (line) => [...plain(line)].length;

/**
 * One inline image: the Kitty escape pi-tui emitted, decoded.
 *
 * `Image.render()` returns the sequence on its own line followed by empty rows
 * for the image's height, and the sequence's control data carries the cell box
 * the terminal is asked to reserve. Kitty splits a payload across several
 * `\x1b_G…;<chunk>\x1b\\` escapes on the same line, so every chunk is
 * concatenated in order - a partial payload is not an image.
 */
function findImages(lines) {
  const images = [];
  const sequence = /\x1b_G([^;]*);([^\x1b]*)\x1b\\/g;
  lines.forEach((line, row) => {
    if (!line.includes("\x1b_G")) return;
    const control = Object.fromEntries(
      (sequence.exec(line)?.[1] ?? "").split(",").map((part) => part.split("=")).filter((part) => part.length === 2),
    );
    let base64 = "";
    sequence.lastIndex = 0;
    for (let match = sequence.exec(line); match; match = sequence.exec(line)) base64 += match[2];
    images.push({
      row,
      column: width(line.slice(0, line.indexOf("\x1b_G"))),
      rows: Number(control.r ?? 1),
      columns: Number(control.c ?? 1),
      base64,
    });
  });
  return images;
}

// The package resolves `@earendil-works/pi-tui` to the top-level copy while the
// extension, loaded through jiti, resolves the nested one. Both are pinned, so
// the screenshot renders through the same path a real terminal would. Pass
// --honour-host to render with whatever the host terminal actually supports,
// which is how the "this terminal cannot draw inline images" state is shown.
const CAPABILITIES = { images: "kitty", trueColor: true, hyperlinks: false, sixel: false, kitty: true };
if (args["honour-host"] === "true") {
  process.stdout.write(`${JSON.stringify({ honourHost: true, detected: (await import("@earendil-works/pi-tui")).getCapabilities() })}\n`);
} else {
  setTopLevelCapabilities(CAPABILITIES);
  setCapabilityOverrides(CAPABILITIES);
}
try {
  const imageBytes = await readFile(imagePath);
  const review = normalizeReview({
    reviewId: "review-shot",
    title: "Incident Queue Layout",
    stages: [
      {
        id: "treatment", kind: "draft", header: "Treatment",
        prompt: "Choose the visual treatment for a regional bus operations dashboard. Compare how quickly an operator finds the most delayed route.",
        options: [
          { id: "airy", label: "Transit airy", description: "Favors quick orientation; trade-off: less detail in secondary states.", image: { path: treatmentImages[0] ?? imagePath, alt: "Generated treatment" } },
          { id: "split", label: "Transit split", description: "Favors balanced context; trade-off: more visual density to scan.", image: { path: treatmentImages[1] ?? treatmentImages[0] ?? imagePath, alt: "Generated treatment" } },
          { id: "dense", label: "Transit dense", description: "Favors maximum detail; trade-off: higher implementation effort.", image: { path: treatmentImages[2] ?? treatmentImages[0] ?? imagePath, alt: "Generated treatment" } },
        ],
      },
    ],
  });
  const tui = { requestRender: () => {}, terminal: { rows } };
  const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };
  const wizard = new VisualReviewWizard(tui, theme, review, ROOT, () => {}, [], undefined, [], "", undefined, undefined);
  // The image loads asynchronously; the screenshot is only honest once the real
  // bytes are in the frame.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && wizard.loadedImages.size === 0) await new Promise((r) => setTimeout(r, 100));
  if (wizard.loadedImages.size === 0 && args["honour-host"] === "true") {
    // With a host that cannot draw images the honest screenshot is the text
    // fallback - that is what the user is looking at - so it is rendered too.
    process.stdout.write(`${JSON.stringify({ note: "the host cannot render inline images; screenshotting the text fallback" })}\n`);
  } else if (wizard.loadedImages.size === 0) {
    throw new Error(`the inline image never loaded for ${imagePath}; the screenshot would be a text fallback`);
  }
  for (let index = 0; index < optionIndex; index += 1) wizard.handleInput("\x1b[B");
  const frame = wizard.render(columns);
  if (args.emit === "true") {
    // Write the frame exactly as a terminal receives it, escape sequences and
    // all. This is the path that proves whether the *host* passes graphics
    // through: run it in a real terminal, look at what is on screen, and the
    // only variable left is tmux/terminal passthrough.
    process.stdout.write("\u001b[H\u001b[2J");
    for (const line of frame) process.stdout.write(`${line}\r\n`);
    process.stdout.write("\u001b[?25l");
    process.stdout.write(`${JSON.stringify({ emitted: true, columns, lines: frame.length, images: findImages(frame).length, capabilities: (await import("@earendil-works/pi-tui")).getCapabilities() })}\n`);
    await new Promise((resolve) => setTimeout(resolve, Number(args.hold ?? 20) * 1000));
    wizard.dispose();
    process.exit(0);
  }
  const payload = {
    title: args.title ?? "pi-visual-review — live dialog",
    subtitle: `${columns}x${rows} terminal · ${imagePath.split("/").pop()}`,
    columns,
    lines: frame.map((line) => plain(line)),
    images: findImages(frame),
  };
  const imageDir = resolve(".pi/benchmark/shots");
  await mkdir(imageDir, { recursive: true });
  for (const [index, image] of payload.images.entries()) {
    const name = `inline-${index + 1}.png`;
    await writeFile(resolve(imageDir, name), Buffer.from(image.base64, "base64"));
    image.path = resolve(imageDir, name);
    delete image.base64;
  }
  payload.imageBytes = (await readFile(imagePath)).length;
  await mkdir(dirname(outPath), { recursive: true });
  const shotJson = `${outPath}.json`;
  await writeFile(shotJson, `${JSON.stringify(payload, null, 2)}\n`);
  execFileSync("python3", [resolve(HERE, "render-shot.py"), shotJson, outPath], { stdio: "inherit" });
  wizard.dispose();
  process.stdout.write(`${JSON.stringify({ out: outPath, lines: payload.lines.length, images: payload.images.length })}\n`);
} finally {
  resetCapabilitiesCache();
}
