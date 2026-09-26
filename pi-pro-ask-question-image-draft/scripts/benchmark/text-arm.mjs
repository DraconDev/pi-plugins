/**
 * The baseline arm: the text/ASCII presentation the package renders today.
 *
 * The visual gate compares generated images against "the current text/ASCII
 * terminal presentation", so the baseline has to be what a user actually sees,
 * not a hand-written summary of the options. These are the same rules
 * `src/tui.ts` applies when no inline image can be rendered:
 *
 * - `renderRows` prints `label` then an indented `description` per row, wrapped
 *   to the available width, with the text mode using the full width
 *   (`leftWidth = safeWidth - 2`) because `imageMode` is false;
 * - `renderSelectedVisual` prints `Preview: <label>`, a blank line, then
 *   `fallbackPreview`, which renders `option.preview` as markdown when present
 *   and otherwise the single line `No inline preview supplied.`
 *
 * Reproducing the rules rather than paraphrasing them is the point: a baseline
 * that is richer than the product would make the images look better than they
 * are, and one that is poorer would make them look worse.
 */

/**
 * Wrap to a column budget, preserving indentation.
 *
 * The TUI prints a row's description as `     <text>` and relies on that indent
 * to nest it under the label. A wrapper that normalises whitespace away - the
 * obvious implementation - silently drops the indent, so the baseline arm was
 * being rendered as flat text rather than as the thing the product prints.
 * Continuations keep the same indent, which is what a wrapped block reads as.
 */
export function wrapText(value, width) {
  const limit = Math.max(1, width);
  const lines = [];
  for (const paragraph of String(value ?? "").split("\n")) {
    const indent = (/^[ \t]*/.exec(paragraph)?.[0] ?? "");
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(indent ? indent : ""); continue; }
    let line = indent + words.shift();
    for (const word of words) {
      if (line.length + 1 + word.length <= limit) line += ` ${word}`;
      else { lines.push(line); line = indent + word; }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

/**
 * The exact lines the TUI prints for one stage in text mode: the question, the
 * option list, and the selected option's preview block.
 */
export function renderTextArm(review, { columns = 110, selectedIndex = 0 } = {}) {
  const stage = review.stages?.[0];
  if (!stage) return [];
  const width = Math.max(1, columns - 2);
  const lines = [];
  lines.push(...wrapText(stage.prompt ?? "", width));
  lines.push("");
  stage.options.forEach((option, index) => {
    lines.push(...wrapText(`${index === selectedIndex ? "> " : "  "}${option.label}`, width));
    if (option.description) {
      for (const line of wrapText(`     ${option.description}`, width)) lines.push(line);
    }
  });
  const selected = stage.options[selectedIndex];
  if (selected) {
    lines.push("");
    lines.push(`Preview: ${selected.label}`);
    lines.push("");
    // fallbackPreview: the preview body when the option carries one, otherwise
    // the product's own "nothing to show" line. No image is attached here,
    // which is precisely the state this baseline represents.
    if (selected.preview) lines.push(...wrapText(selected.preview, width));
    else lines.push("No inline preview supplied.");
  }
  return lines;
}

/** The baseline as one block of text, for the judge's comparison prompt. */
export function textArmForScenario(scenario, options = {}) {
  return renderTextArm(scenario.canonicalInput, options).join("\n");
}
