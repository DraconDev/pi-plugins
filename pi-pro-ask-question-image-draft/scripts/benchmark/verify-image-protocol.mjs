#!/usr/bin/env node
/**
 * Verify the inline-image bytes we emit, escape sequence by escape sequence.
 *
 * Why this exists
 * ---------------
 * "Is the image feature actually working?" has three separate answers, and only
 * the third needs a human eye:
 *
 *   1. Do the image bytes reach the terminal at all?          A PTY answers that.
 *   2. Are they the right bytes, in a sequence a conforming terminal accepts?
 *      This script answers that, strictly, with a real parser.
 *   3. Does *your* terminal draw them?                        Only a person can.
 *
 * This script does (2) for every protocol the package emits - Kitty APC, iTerm2
 * OSC 1337, and the tmux passthrough envelope - by rendering the real wizard
 * frame, parsing the escapes back, reassembling the image, and comparing it to
 * the source file byte for byte. A payload that is truncated, mis-chunked, or
 * wrapped so the terminal cannot terminate it fails here, rather than silently
 * drawing nothing on a screen.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

const sourcePaths = (args.get("images") ?? `${ROOT}/.pi/benchmark/images/visual-001-option-1.png,${ROOT}/.pi/benchmark/images/visual-001-option-2.png`)
  .split(",").map((value) => resolve(value.trim()));
const columns = Number(args.get("columns") ?? 120);
const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t, dim: (t) => t, italic: (t) => t, underline: (t) => t, inverse: (t) => t };

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(detail ? `${label}: ${detail}` : label);
  return condition;
};
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const sourceDigests = new Map();
for (const path of sourcePaths) sourceDigests.set(sha256(await readFile(path)), path);
const isSourceImage = (buffer) => sourceDigests.has(sha256(buffer));

/**
 * A strict Kitty APC parser: `ESC _ G <keys> ; <payload> ESC \`, optionally
 * inside tmux's `ESC P tmux ; ... ESC \` passthrough envelope. Chunks with
 * `m=1` continue; the last chunk carries no `m`, so a complete transmission is
 * every chunk concatenated in order.
 */
export function parseKitty(text) {
  const images = [];
  const pattern = /(?:\u001bPtmux;)?\u001b_G([^;]*);([^\u001b]*)\u001b\\/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const keys = Object.fromEntries(match[1].split(",").map((pair) => pair.split("=")).filter((pair) => pair.length === 2));
    const wrapped = text.slice(Math.max(0, match.index - 6), match.index) === "\u001bPtmux;";
    const previous = images.at(-1);
    if (previous && keys.m === "1") {
      previous.payload += match[2];
      previous.chunks += 1;
      continue;
    }
    images.push({ keys, payload: match[2], chunks: 1, wrapped, more: keys.m === "1" });
  }
  return images;
}

/** iTerm2 inline image: `ESC ] 1337 ; File=<args> :<base64>` + BEL or ST. */
export function parseITerm2(text) {
  const images = [];
  const pattern = /\u001b\]1337;File=([^:]*):([A-Za-z0-9+/=]*)(?:\u0007|\u001b\\)/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const keys = Object.fromEntries(match[1].split(";").map((pair) => pair.split("=")).filter((pair) => pair.length === 2));
    images.push({ keys, payload: match[2] });
  }
  return images;
}

/** Render the real wizard with a given protocol and return the frame a terminal receives. */
async function renderWith(protocol) {
  setCapabilities({ images: protocol, trueColor: true, hyperlinks: false });
  const review = normalizeReview({
    reviewId: "image-verify",
    title: "Incident Queue Layout",
    stages: [{
      id: "treatment", kind: "draft", header: "Treatment", prompt: "Which treatment ships?",
      options: sourcePaths.map((path, index) => ({
        id: `option-${index + 1}`,
        label: `Treatment ${index + 1}`,
        description: "A generated treatment.",
        image: { path, alt: "Generated treatment" },
      })),
    }],
  });
  const wizard = new VisualReviewWizard({ requestRender: () => {}, terminal: { rows: 46 } }, theme, review, ROOT, () => {});
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && wizard.loadedImages.size < sourcePaths.length) {
    await new Promise((tick) => setTimeout(tick, 80));
  }
  check(`${protocol}: every option image loads`, wizard.loadedImages.size === sourcePaths.length, `${wizard.loadedImages.size}/${sourcePaths.length}`);
  const frame = wizard.render(columns).join("\r\n");
  wizard.dispose();
  return frame;
}

const report = { sources: sourcePaths.map((path) => path.split("/").pop()) };

// --- Kitty, as a terminal receives it ---------------------------------------
{
  const frame = await renderWith("kitty");
  const images = parseKitty(frame);
  report.kitty = { escapes: images.length };
  check("kitty: the frame carries an inline image", images.length > 0, `${images.length} escapes`);
  for (const [index, image] of images.entries()) {
    const label = `kitty image ${index + 1}`;
    check(`${label}: the transmission is complete`, image.more !== true, "the last chunk still had a continuation flag");
    check(`${label}: the payload is PNG data`, image.keys.f === "100", `f=${image.keys.f}`);
    // a=T is "transmit, display, do not wait for a response" in the kitty spec.
    check(`${label}: transmit and display`, image.keys.a === "T" || image.keys.a === "t", `a=${image.keys.a}`);
    check(`${label}: a cell box is requested`, Number(image.keys.c) > 0 && Number(image.keys.r) > 0, `c=${image.keys.c} r=${image.keys.r}`);
    check(`${label}: quiet, so the terminal does not reply`, image.keys.q === "2", `q=${image.keys.q}`);
    const decoded = Buffer.from(image.payload, "base64");
    check(`${label}: the payload is its source file, byte for byte`, isSourceImage(decoded), `${decoded.length} bytes, sha ${sha256(decoded).slice(0, 12)}`);
  }
  report.kitty.chunks = images.reduce((sum, image) => sum + image.chunks, 0);
  report.kitty.payloadBytes = images.map((image) => Buffer.from(image.payload, "base64").length);
  report.kitty.identical = images.length > 0 && images.every((image) => isSourceImage(Buffer.from(image.payload, "base64")));
}

// --- iTerm2 -----------------------------------------------------------------
{
  const frame = await renderWith("iterm2");
  const images = parseITerm2(frame);
  report.iterm2 = { escapes: images.length };
  check("iterm2: the frame carries an inline image", images.length > 0, `${images.length} escapes`);
  for (const [index, image] of images.entries()) {
    const label = `iterm2 image ${index + 1}`;
    check(`${label}: inline, not an attachment`, image.keys.inline === "1", `inline=${image.keys.inline}`);
    const decoded = Buffer.from(image.payload, "base64");
    check(`${label}: the payload is its source file, byte for byte`, isSourceImage(decoded), `${decoded.length} bytes`);
  }
  report.iterm2.payloadBytes = images.map((image) => Buffer.from(image.payload, "base64").length);
  report.iterm2.identical = images.length > 0 && images.every((image) => isSourceImage(Buffer.from(image.payload, "base64")));
}

// --- The same bytes, wrapped for tmux --------------------------------------
{
  const previous = process.env.TMUX;
  process.env.TMUX = "on"; // the wrapper keys off this at render time
  const frame = await renderWith("kitty");
  if (previous === undefined) delete process.env.TMUX;
  else process.env.TMUX = previous;
  const images = parseKitty(frame);
  const wrapped = images.filter((image) => image.wrapped);
  report.tmux = { escapes: images.length, wrapped: wrapped.length };
  check("tmux: every escape travels inside a passthrough envelope", images.length > 0 && wrapped.length === images.length, `${wrapped.length}/${images.length} wrapped`);
  // One escape per image, because the envelope ends at the first ST inside it.
  check("tmux: the chunks are collapsed to one escape per image", images.every((image) => image.chunks === 1), images.map((image) => image.chunks).join(","));
  const decoded = images.map((image) => Buffer.from(image.payload, "base64"));
  report.tmux.identical = decoded.length > 0 && decoded.every((buffer) => isSourceImage(buffer));
  check("tmux: the payload survives the wrapper", report.tmux.identical);
}

report.ok = failures.length === 0;
report.failures = failures;
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
