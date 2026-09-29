/**
 * The panel's invariants, measured across the whole shape matrix.
 *
 * Everything this script checks is a promise the panel makes on every frame,
 * and every one of them has been broken at some point by something that looked
 * like a reasonable local change:
 *
 *   tail      - the key hints, the auto-resolve line, the density line and the
 *               closing rule are on screen, as one block, in that order. They
 *               are the controls; a frame that has lost them is a form nobody
 *               can drive.
 *   height    - the panel is a fixed block, not the terminal. The one way to
 *               lose this is for a band to be emptied and the slack that was
 *               padding the picture to be handed to nothing, at which point the
 *               frame grows until it fills every row.
 *   marker    - the row the cursor is on carries the `>` marker and is inside
 *               the frame. A frame with no visible cursor is a frame where
 *               Enter answers on a choice nobody was shown.
 *
 * It exists so a round can be compared against a baseline *with the same
 * harness*: run it on one checkout and another and diff the summary line. The
 * point is that the harness can tell the difference - reintroduce any of the
 * three defects and this reports it - so a clean line means something.
 *
 *   node scripts/benchmark/panel-invariants.mjs            # summary
 *   node scripts/benchmark/panel-invariants.mjs --verbose  # per configuration
 *
 * Exit code 0 when every configuration holds, 1 otherwise.
 */
import { setCapabilities } from "@earendil-works/pi-tui";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { VisualReviewWizard } from "../../src/tui.ts";
import { normalizeReview } from "../../src/schema.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const IMAGE = resolve(ROOT, ".pi/benchmark/images/visual-001-option-1.png");

const verbose = process.argv.includes("--verbose");

const RULE = /^[─━═_-]{10,}$/;
const HINTS = /↑↓ move/;
const AUTO = /auto-resolve/;
const DENSITY = /density: (comfortable|compact)/;
const MARKER = /^\s*>\s/;

// The panel's own bound. A review is allowed to outgrow it only once the option
// list is long enough to be the panel's whole job, so the check is per
// configuration rather than a flat line count.
const PANEL_CEILING = 36;

const theme = {
  fg: (_c, text) => text,
  bg: (_c, text) => text,
  bold: (text) => text,
  dim: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
};

const plain = (lines) => lines.map((line) => line.replace(/\[[0-9;?]*[ -/]*[@-~]/g, ""));

const build = ({ options, multiSelect, density, withImage }) => normalizeReview({
  reviewId: "panel-invariants",
  images: withImage ? "on" : "off",
  ...(density === "compact" ? { density } : {}),
  stages: [{
    id: "one",
    header: "Treatment",
    prompt: "Which treatment ships first?",
    multiSelect,
    options: Array.from({ length: options }, (_, index) => ({
      id: `o${index}`,
      label: `Option ${index + 1}`,
      ...(withImage ? { image: { path: IMAGE, alt: "Fixture" } } : {}),
      description: `Favors option ${index + 1}; trade-off: a one-to-two sentence reason line.`,
    })),
  }],
});

/** Every invariant, as a list of failures with the reason. */
const measure = (component, width) => {
  const lines = plain(component.render(width));
  const frame = lines.join("\n");
  const failures = [];

  const hintAt = lines.findIndex((line) => HINTS.test(line));
  const autoAt = lines.findIndex((line) => AUTO.test(line));
  const densityAt = lines.findIndex((line) => DENSITY.test(line));
  // The frame is ruled at the top as well as the bottom, so the closing rule is
  // the last one on screen.
  const ruleAt = lines.findLastIndex((line) => RULE.test(line.trim()));
  if (hintAt < 0) failures.push("tail: no key hints");
  if (autoAt < 0) failures.push("tail: no auto-resolve line");
  if (densityAt < 0) failures.push("tail: no density line");
  if (ruleAt < 0) failures.push("tail: no closing rule");
  if (hintAt >= 0 && (autoAt !== hintAt + 1 || densityAt !== autoAt + 1 || ruleAt <= densityAt)) {
    failures.push(`tail: not one block (hints ${hintAt}, auto ${autoAt}, density ${densityAt}, rule ${ruleAt})`);
  }
  if (lines.length > PANEL_CEILING) {
    failures.push(`height: the frame is ${lines.length} rows, past the panel's ${PANEL_CEILING}`);
  }
  const marked = lines.filter((line) => MARKER.test(line));
  if (marked.length === 0) failures.push("marker: no marked row on screen");
  return { failures, lines: lines.length, marked: marked.length };
};

const settleImages = async (component) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && component.loadedImages.size === 0) {
    await new Promise((resolve_) => setTimeout(resolve_, 25));
  }
};

const configurations = [];
for (const rows of [44, 36, 30, 24]) {
  for (const columns of [60, 80, 120]) {
    for (const withImage of [false, true]) {
      for (const density of ["comfortable", "compact"]) {
        for (const multiSelect of [false, true]) {
          for (const options of [4, 8, 14, 20]) {
            configurations.push({ rows, columns, withImage, density, multiSelect, options });
          }
        }
      }
    }
  }
}

const previous = setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const summary = { tail: 0, height: 0, marker: 0 };
const broken = [];
let frames = 0;

try {
  for (const config of configurations) {
    const component = new VisualReviewWizard(
      { requestRender: () => {}, terminal: { rows: config.rows, columns: config.columns } },
      theme,
      build(config),
      process.cwd(),
      () => {},
    );
    if (config.withImage) await settleImages(component);
    const tag = `${config.rows}x${config.columns} ${config.withImage ? "image" : "text "} ${config.density} multi=${config.multiSelect} n=${config.options}`;
    // The first frame, then the list walked down and back up, checking every
    // keystroke: an invariant that holds only at rest is not an invariant.
    const states = [];
    const record = (label) => {
      const result = measure(component, 100);
      frames += 1;
      for (const failure of result.failures) summary[failure.split(":")[0]] += 1;
      if (result.failures.length) broken.push(`${tag} ${label}: ${result.failures.join("; ")}`);
      states.push(result);
    };
    record("first frame");
    const rowCount = component.currentRows().length;
    for (const key of ["[B", "[A"]) {
      for (let step = 0; step < rowCount + 2; step += 1) {
        component.handleInput(key);
        record(key === "[B" ? `down ${step + 1}` : `up ${step + 1}`);
      }
    }
    component.handleInput("");
    record("density toggled");
    if (verbose) console.log(`${tag}  frames=${states.length} rows=${states[0]?.lines}`);
    component.dispose();
  }
} finally {
  if (previous) setCapabilities(previous);
}

const failures = broken.length;
console.log(`configurations=${configurations.length} frames=${frames} configurationsWithFailures=${failures}`);
console.log(`failures: tail=${summary.tail} height=${summary.height} marker=${summary.marker}`);
for (const entry of broken.slice(0, 12)) console.log(`  ${entry}`);
if (failures > 12) console.log(`  ... and ${failures - 12} more`);
console.log(failures === 0 ? "panel-invariants: PASS" : "panel-invariants: FAIL");
process.exit(failures === 0 ? 0 : 1);
