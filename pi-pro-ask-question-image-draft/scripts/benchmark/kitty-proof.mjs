#!/usr/bin/env node
/**
 * Draw one image with the exact bytes the review sends, and nothing else.
 *
 * Why this exists: every argument about "is the image feature working" has been
 * a disagreement between two kinds of evidence - our byte-level check, which
 * is green, and a screen, which shows nothing. This removes the review, the
 * package and the multiplexer from the question: it writes the same Kitty
 * escape `src/tui.ts` writes and then stops. A picture here means the terminal
 * is fine and the review is at fault. No picture here means the terminal is.
 *
 *   env -u TMUX npm run proof:image        # in Ghostty, outside tmux
 *   npm run proof:image                     # inside tmux, for the contrast
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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

const imagePath = resolve(args.get("image") ?? ".pi/benchmark/images/visual-001-option-1.png");
const columns = Number(args.get("columns") ?? 46);
const rows = Number(args.get("rows") ?? 20);
const hold = Number(args.get("hold") ?? 8);

if (!existsSync(imagePath)) {
  process.stderr.write(`proof:image: no image at ${imagePath}\n`);
  process.exit(1);
}
const base64 = readFileSync(imagePath).toString("base64");

// The same shape the review emits: Kitty APC, PNG, quiet, cursor held, in
// 4096-character chunks - which is what pi-tui's encoder produces.
const CHUNK = 4096;
const chunks = [];
for (let index = 0; index < base64.length; index += CHUNK) chunks.push(base64.slice(index, index + CHUNK));
const sequence = chunks.map((chunk, index) => {
  const more = index < chunks.length - 1 ? "1" : "0";
  const control = index === 0
    ? `a=T,f=100,q=2,C=1,c=${columns},r=${rows},m=${more}`
    : `m=${more}`;
  return `\u001b_G${control};${chunk}\u001b\\`;
}).join("");

const inTmux = Boolean(process.env.TMUX);
const info = [
  `image: ${imagePath} (${base64.length} base64 chars, ${chunks.length} chunks)`,
  `cell box: ${columns}x${rows} cells`,
  `inside tmux: ${inTmux ? process.env.TMUX : "no"}`,
  "drawing in 1s; this window is held for " + hold + "s",
];

process.stdout.write(`${info.join("\n")}\n\n`);
process.stdout.write(`\u001b[H\u001b[2J${sequence}`);
process.stdout.write("\u001b[?25l");

// A marker under the picture: if you see the marker and no picture, the bytes
// arrived and the terminal declined them. No marker at all means the escape was
// mangled on the way (which is what a multiplexer does).
setTimeout(() => {
  process.stdout.write(`\u001b[${rows + 2};1H\u001b[0m  <- picture above this line?\n`);
  writeFileSync("/tmp/kitty-proof.pid", String(process.pid));
}, 1000);
setTimeout(() => process.exit(0), hold * 1000);
