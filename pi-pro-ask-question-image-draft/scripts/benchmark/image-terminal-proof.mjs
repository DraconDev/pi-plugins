#!/usr/bin/env node
/**
 * Render the real wizard frame into a page a browser can replay.
 *
 * What this is: the real `VisualReviewWizard` frame - same component, same
 * renderer, same inline-image escape a terminal receives - embedded in a page
 * that runs xterm.js with its image addon, so a person can open it and look.
 *
 * What this is NOT: evidence. It is not part of any gate, it asserts nothing,
 * and it is not wired into the test suite. In this environment the browser
 * emulator rendered no rows at all - even a bare `Terminal.write("HELLO")` came
 * back empty - so the page has not been shown to display an image here, and no
 * claim in this repository rests on it. The automated answer to "are the bytes
 * right" is `npm run verify:image`; the answer to "does your terminal draw it"
 * is a person looking at their own screen, or this page.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { setCapabilities } from "@earendil-works/pi-tui";
import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");

const args = new Map();
for (let index = 0; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const [key, ...rest] = token.replace(/^--/, "").split("=");
  if (rest.length) { args.set(key, rest.join("=")); continue; }
  const next = process.argv[index + 1];
  if (next !== undefined && !next.startsWith("--")) { args.set(key, next); index += 1; continue; }
  args.set(key, "true");
}

const outPath = resolve(args.get("out") ?? ".pi/benchmark/shots/image-proof.html");
const images = (args.get("images") ?? `${ROOT}/.pi/benchmark/images/visual-001-option-1.png,${ROOT}/.pi/benchmark/images/visual-001-option-2.png`)
  .split(",").map((value) => resolve(value.trim()));
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };

// A terminal that understands OSC 1337 inline images.
setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });

const review = normalizeReview({
  reviewId: "image-proof",
  title: "Incident Queue Layout",
  stages: [{
    id: "treatment", kind: "draft", header: "Treatment", prompt: "Which treatment ships?",
    options: images.map((path, index) => ({
      id: `option-${index + 1}`,
      label: ["Transit airy", "Transit split", "Transit dense"][index] ?? `Treatment ${index + 1}`,
      description: ["Quick orientation, less secondary detail.", "Balanced context, more density to scan.", "Maximum detail, higher cost."][index] ?? "A generated treatment.",
      image: { path, alt: "Generated treatment" },
    })),
  }],
});

const wizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 44 } }, theme, review, ROOT, () => {});
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && wizard.loadedImages.size < images.length) {
  await new Promise((resolveTick) => setTimeout(resolveTick, 80));
}
if (wizard.loadedImages.size < images.length) {
  throw new Error(`only ${wizard.loadedImages.size}/${images.length} option images loaded, so the proof would show a text fallback`);
}

const columns = Number(args.get("columns") ?? 110);
const frame = wizard.render(columns);
const graphics = frame.filter((line) => line.includes("1337") || line.includes("\u001b_G"));
if (graphics.length === 0) {
  throw new Error("the rendered frame carries no inline image, so there is nothing to prove");
}
const stream = `\u001b[2J\u001b[H${frame.join("\r\n")}\r\n`;
const encoded = Buffer.from(stream, "utf8").toString("base64");

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>pi-visual-review — inline image proof</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  body { background:#0f1116; color:#8b93a3; font:12px/1.5 system-ui, sans-serif; margin:0; padding:14px; }
  h1 { font-size:13px; font-weight:600; color:#cfd6e4; margin:0 0 4px; }
  p { margin:0 0 10px; }
  #term { background:#12141a; padding:6px; border-radius:6px; }
</style>
</head><body>
<h1>pi-visual-review — the real wizard frame, played into xterm.js with its image addon</h1>
<p>Frame bytes: ${stream.length} · inline image escapes: ${graphics.length} · options with images: ${wizard.loadedImages.size}</p>
<div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-image@0.9.0/lib/addon-image.js"></script>
<script>
  const FRAME = "${encoded}";
  const term = new Terminal({ cols: ${columns}, rows: 44, fontFamily: "DejaVu Sans Mono, monospace", fontSize: 13, allowProposedApi: true, cursorBlink: false, rendererType: "canvas" });
  // The UMD bundle assigns the module namespace onto the global, so the class
  // lives at ImageAddon.ImageAddon; older builds put it there directly.
  const ImageAddonCtor = (window.ImageAddon && window.ImageAddon.ImageAddon) || window.ImageAddon;
  const images = new ImageAddonCtor();
  term.loadAddon(images);
  term.open(document.getElementById("term"));
  const bytes = Uint8Array.from(atob(FRAME), (c) => c.charCodeAt(0));
  const decoded = new TextDecoder().decode(bytes);
  term.write(decoded);
  // Diagnostics on the page itself: a proof that cannot report its own state is
  // a screenshot, not evidence.
  window.__proof = {
    frameBytes: bytes.length,
    escapesInFrame: (decoded.match(/\\u001b\]1337;File=/g) || []).length,
    addonLoaded: !!images,
    images: [...document.querySelectorAll("#term img")].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight })),
    canvases: [...document.querySelectorAll("#term canvas")].map((c) => ({ w: c.width, h: c.height, cls: c.className })),
  };
</script>
</body></html>`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, html, "utf8");
wizard.dispose();
process.stdout.write(`${JSON.stringify({ out: outPath, frameBytes: stream.length, inlineImageEscapes: graphics.length, loadedImages: images.length, protocol: "iterm2 (OSC 1337)" })}\n`);
